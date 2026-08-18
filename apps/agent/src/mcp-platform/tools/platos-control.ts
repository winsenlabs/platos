/**
 * Theme K.8 — Platform MCP tools for the Platos control plane.
 *
 * Bundles wrappers for memories, providers, approvals, budgets, evals,
 * artifacts, monitoring (cost) reads, audit (tool_calls + safety_events),
 * and GDPR user-data primitives.
 *
 * No new business logic — every handler delegates to an existing service.
 *
 * Tier-1 require_approval (hardcoded in `permission-gateway.service.ts`):
 *   - gdpr.*                  (export / import / purge — irreversible)
 *   - memories.import_replace (already present from an earlier batch)
 */

import type { MemoryService } from "../../memory/memory.service";
import type { MemoryExtractionService } from "../../memory/memory-extraction.service";
import type { ConversationService } from "../../memory/conversation.service";
import type { KnowledgeGraphService } from "../../memory/knowledge-graph.service";
import type { ProviderRegistryService } from "../../providers/provider-registry.service";
import type { MonitoringApprovalsService } from "../../monitoring/approvals.service";
import type { BudgetService } from "../../monitoring/budget.service";
import type { EvalService } from "../../evals/eval.service";
import type { CostService } from "../../monitoring/cost.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { SafetyEventService } from "../../monitoring/safety-event.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function buildPlatosControlToolHandlers(deps: {
  memory: MemoryService;
  memoryExtraction: MemoryExtractionService;
  conversation: ConversationService;
  graph: KnowledgeGraphService;
  providers: ProviderRegistryService;
  approvals: MonitoringApprovalsService;
  budgets: BudgetService;
  evals: EvalService;
  cost: CostService;
  toolAudit: ToolAuditService;
  safetyEvents: SafetyEventService;
}): McpToolHandler[] {
  const {
    memory,
    memoryExtraction,
    conversation,
    graph,
    providers,
    approvals,
    budgets,
    evals,
    cost,
    toolAudit,
    safetyEvents,
  } = deps;

  // MCPF-W2 — fire-and-forget audit trail for mutating memories.* tools.
  // Mirrors the shape used elsewhere (entities.ts, tools/index.ts) so MCP-
  // driven memory edits surface in the same dashboard rows as REST writes.
  function auditMemoryMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    error?: string,
  ): void {
    toolAudit
      .record({
        scope: tuple(scope),
        toolName,
        userId: scope.userId ?? null,
        args,
        result,
        ...(error !== undefined ? { error } : {}),
        status,
        latencyMs: Date.now() - startedAt,
        source: "mcp_platform",
      })
      .catch(() => undefined);
  }

  return [
    // ── memories.* ─────────────────────────────────────────────────
    {
      name: "memories.list",
      description:
        "List memories for a user in the token's scope. Orders by lastAccessedAt DESC then createdAt DESC.",
      inputSchema: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string" },
          kind: { type: "string" },
          agentId: { type: ["string", "null"] },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0, maximum: 10_000 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const rows = await memory.list(tuple(scope), {
          userId: String(params["userId"]),
          ...(params["kind"] !== undefined ? { kind: params["kind"] as string } : {}),
          ...(params["agentId"] !== undefined
            ? { agentId: params["agentId"] as string | null }
            : {}),
          ...(params["limit"] !== undefined ? { limit: params["limit"] as number } : {}),
          ...(params["offset"] !== undefined ? { offset: params["offset"] as number } : {}),
        });
        return { memories: rows };
      },
    },
    {
      name: "memories.search",
      description:
        "Semantic search over memories for a user. Overfetches through pgvector HNSW cosine recall, then returns non-quarantined hits ordered by rankingScore (80% cosine / 20% confidence) with stable ID ties. score remains cosine similarity and minScore filters cosine.",
      inputSchema: {
        type: "object",
        required: ["query", "userId"],
        properties: {
          query: { type: "string" },
          userId: { type: "string" },
          kind: { type: "string" },
          agentId: { type: ["string", "null"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          minScore: { type: "number" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const hits = await memory.semanticSearch(tuple(scope), {
          query: String(params["query"]),
          userId: String(params["userId"]),
          ...(params["kind"] !== undefined ? { kind: params["kind"] as string } : {}),
          ...(params["agentId"] !== undefined
            ? { agentId: params["agentId"] as string | null }
            : {}),
          ...(params["limit"] !== undefined ? { limit: params["limit"] as number } : {}),
          ...(params["minScore"] !== undefined
            ? { minScore: params["minScore"] as number }
            : {}),
        });
        return { hits };
      },
    },
    {
      name: "memories.upsert",
      description:
        "Add a memory row for a user. Re-uses the `add` path — dedupe on " +
        "(scope, user, thread, sha256(content)) is automatic for extractor " +
        "rows. The `content` field is the body of the memory; `text` is " +
        "accepted as a one-call alias for backwards compatibility (callers " +
        "have shipped both shapes). When `kind: \"profile\"` is used, " +
        "`metadata.profileKey` is REQUIRED — the memory validator " +
        "rejects profile rows without it.",
      inputSchema: {
        type: "object",
        // MCPF-followup — `userId` is required; `content` OR `text` must be
        // supplied (we can't express "one of" cleanly in plain JSON Schema
        // without anyOf, so we keep the required list to userId and check
        // for content/text in the handler).
        required: ["userId"],
        properties: {
          userId: { type: "string" },
          content: { type: "string" },
          // MCPF-followup — accept `text` as an alias for `content`. Some
          // callers (and the spec excerpt) use `text`; the underlying
          // memory.add service expects `content`. The handler maps
          // `text` → content when `content` is omitted.
          text: { type: "string" },
          // MCPF-followup — `profile` was missing from this enum even
          // though `MemoryService.add` accepts it (and the kind validator
          // requires `metadata.profileKey` for it). Add to enum so the
          // schema validator allows the call through.
          kind: {
            type: "string",
            enum: ["fact", "preference", "event", "relationship", "profile"],
          },
          agentId: { type: ["string", "null"] },
          metadata: { type: "object" },
          visibility: {
            type: "string",
            enum: ["agent_visible", "hidden", "private"],
          },
          source: { type: "string", enum: ["manual", "extracted", "imported"] },
          sourceThreadId: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        // MCPF-followup — accept `text` as an alias for `content`. The
        // schema declares both as optional; the handler ensures at least
        // one is non-empty. Map text → content if needed.
        const rawContent = params["content"] as string | undefined;
        const rawText = params["text"] as string | undefined;
        const content = (rawContent && rawContent.length > 0)
          ? rawContent
          : (rawText && rawText.length > 0 ? rawText : undefined);
        if (!content) {
          return {
            error: "invalid_input",
            message: "memories.upsert: one of `content` or `text` is required",
          };
        }
        const kind = params["kind"] as string | undefined;
        // MCPF-followup — surface the profile-kind requirement as a clean
        // tool-result error rather than letting it surface as an opaque
        // 400 from the validator deep in the service.
        if (kind === "profile") {
          const meta = (params["metadata"] as Record<string, unknown> | undefined) ?? {};
          if (!meta || typeof (meta as any).profileKey !== "string" || (meta as any).profileKey.length === 0) {
            return {
              error: "missing_profile_key",
              message:
                "memories.upsert with kind=\"profile\" requires `metadata.profileKey` (e.g. \"name\", \"role\").",
            };
          }
        }
        const row = await memory.add(tuple(scope), {
          userId: String(params["userId"]),
          content,
          ...(kind !== undefined ? { kind: kind as any } : {}),
          ...(params["agentId"] !== undefined
            ? { agentId: params["agentId"] as string | null }
            : {}),
          ...(params["metadata"] !== undefined ? { metadata: params["metadata"] } : {}),
          ...(params["visibility"] !== undefined
            ? { visibility: params["visibility"] as any }
            : {}),
          ...(params["source"] !== undefined ? { source: params["source"] as any } : {}),
          ...(params["sourceThreadId"] !== undefined
            ? { sourceThreadId: params["sourceThreadId"] as string | null }
            : {}),
        });
        return { memory: row };
      },
    },
    {
      name: "memories.delete",
      description:
        "Delete a memory row by id. Scope-guarded — cross-scope ids silently no-op and return `{ ok: false }`.",
      inputSchema: {
        type: "object",
        required: ["memoryId"],
        properties: { memoryId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["memoryId"]);
        const startedAt = Date.now();
        try {
          const ok = await memory.delete(tuple(scope), id);
          const result = { ok, memoryId: id };
          auditMemoryMutation(scope, "memories.delete", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMemoryMutation(scope, "memories.delete", params, null, "failed", startedAt, message);
          return { error: "delete_failed", message };
        }
      },
    },

    // ── MCPF-W2 memories extensions ────────────────────────────────
    {
      name: "memories.extract_now",
      description:
        "Trigger the memory extractor against a thread immediately (bypassing " +
        "the scheduled sweep). Honours the agent's stored `extractionPolicy`; " +
        "pass `policyOverride` to tweak `enabled` / `kinds` / " +
        "`confidenceThreshold` / `maxPerSession` / `minMessagesBeforeRun` for " +
        "this run only. Returns counts of memories / entities / relationships " +
        "created plus a `reason` string when nothing landed.",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        properties: {
          threadId: { type: "string" },
          policyOverride: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              kinds: {
                type: "array",
                items: { type: "string", enum: ["fact", "preference", "event", "relationship"] },
              },
              confidenceThreshold: { type: "number", minimum: 0, maximum: 1 },
              maxPerSession: { type: "integer", minimum: 1, maximum: 100 },
              minMessagesBeforeRun: { type: "integer", minimum: 1, maximum: 200 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const threadId = String(params["threadId"]);
        const policyOverride = params["policyOverride"] as Record<string, unknown> | undefined;
        try {
          const out = await memoryExtraction.extractFromThread(tuple(scope), {
            force: true, // manual extract-now bypasses the no-new-activity watermark
            threadId,
            ...(policyOverride !== undefined
              ? { policyOverride: policyOverride as any }
              : {}),
          });
          auditMemoryMutation(scope, "memories.extract_now", params, out, "success", startedAt);
          return out;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMemoryMutation(
            scope,
            "memories.extract_now",
            params,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "extract_failed", message };
        }
      },
    },
    {
      name: "memories.get",
      description:
        "Fetch a single memory row by id. Returns the full content + " +
        "metadata + visibility + archivedAt (so callers can check whether " +
        "the row is archived). Scope-guarded — cross-scope ids 404. " +
        "Includes archived rows so the editor / restore flow can see them.",
      inputSchema: {
        type: "object",
        required: ["memoryId"],
        properties: { memoryId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["memoryId"]);
        const row = await memory.get(tuple(scope), id);
        if (!row) throw new Error(`memory ${id} not found in scope`);
        return row;
      },
    },
    {
      name: "memories.archive",
      description:
        "Soft-delete a memory by id. Sets `archivedAt = now()`. Archived " +
        "rows are filtered out of `memories.list` / `memories.search` / " +
        "agent recall by default. Restore via `memories.restore`. " +
        "Idempotent for already-archived rows: returns " +
        "`{ ok: false, archivedAt: null }`.",
      inputSchema: {
        type: "object",
        required: ["memoryId"],
        properties: { memoryId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const id = String(params["memoryId"]);
        try {
          const out = await memory.archive(tuple(scope), id);
          const result = { ok: out.ok, memoryId: id, archivedAt: out.archivedAt };
          auditMemoryMutation(scope, "memories.archive", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMemoryMutation(scope, "memories.archive", params, null, "failed", startedAt, message);
          return { error: "archive_failed", message };
        }
      },
    },
    {
      name: "memories.restore",
      description:
        "Undelete an archived memory by id. Clears `archivedAt`. Returns " +
        "`{ ok: false, memory: null }` for cross-scope ids or rows that " +
        "weren't archived.",
      inputSchema: {
        type: "object",
        required: ["memoryId"],
        properties: { memoryId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const id = String(params["memoryId"]);
        try {
          const out = await memory.restore(tuple(scope), id);
          const result = { ok: out.ok, memoryId: id, memory: out.memory };
          auditMemoryMutation(scope, "memories.restore", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMemoryMutation(scope, "memories.restore", params, null, "failed", startedAt, message);
          return { error: "restore_failed", message };
        }
      },
    },
    {
      name: "memories.bulk_delete",
      description:
        "Hard-delete up to 100 memories in one call by id list. Scope " +
        "filter is authoritative — cross-scope ids in the list are silently " +
        "ignored. Returns `{ deleted }` count of rows actually removed. " +
        "Use `memories.archive` for the reversible path.",
      inputSchema: {
        type: "object",
        required: ["memoryIds"],
        properties: {
          memoryIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 100,
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const raw = params["memoryIds"];
        const ids = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
        if (ids.length === 0) {
          return { error: "memoryIds_required", deleted: 0 };
        }
        if (ids.length > 100) {
          return { error: "memoryIds_too_many", message: "max 100 ids per request", deleted: 0 };
        }
        try {
          const out = await memory.bulkDelete(tuple(scope), ids);
          const result = { deleted: out.deleted, requested: ids.length };
          // Don't echo the full id list back into the audit row; just the count.
          auditMemoryMutation(
            scope,
            "memories.bulk_delete",
            { count: ids.length },
            result,
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMemoryMutation(
            scope,
            "memories.bulk_delete",
            { count: ids.length },
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "bulk_delete_failed", message };
        }
      },
    },

    // ── providers.* ────────────────────────────────────────────────
    {
      name: "providers.list",
      description:
        "List every LLM provider manifest with current-scope state (envReady, enabled, linked, models).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const rows = await providers.list(tuple(scope));
        return { providers: rows };
      },
    },
    {
      name: "providers.link",
      description: "Opt-in to a provider (scope-level). User must also link the required env vars.",
      inputSchema: {
        type: "object",
        required: ["providerId"],
        properties: { providerId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const providerId = String(params["providerId"]);
        return providers.link(tuple(scope), providerId);
      },
    },
    {
      name: "providers.unlink",
      description: "Remove a provider's linked row — returns it to unlinked state.",
      inputSchema: {
        type: "object",
        required: ["providerId"],
        properties: { providerId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const providerId = String(params["providerId"]);
        await providers.unlink(tuple(scope), providerId);
        return { ok: true, providerId };
      },
    },

    // ── approvals.* ────────────────────────────────────────────────
    {
      name: "approvals.list",
      description:
        "List HITL approval rows in the token's scope. Defaults to the last 30 days.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          agentId: { type: "string" },
          status: { type: "string" },
          source: { type: "string" },
          sinceDays: { type: "integer", minimum: 1, maximum: 365 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const filters: Record<string, unknown> = {};
        for (const key of ["threadId", "agentId", "status", "source", "sinceDays", "limit", "offset"]) {
          if (params[key] !== undefined) filters[key] = params[key];
        }
        return approvals.list(tuple(scope), filters as any);
      },
    },
    {
      name: "approvals.get",
      description: "Fetch a single approval by its `approvalId` (idempotency key).",
      inputSchema: {
        type: "object",
        required: ["approvalId"],
        properties: { approvalId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["approvalId"]);
        const row = await approvals.getById(tuple(scope), id);
        if (!row) throw new Error(`approval ${id} not found in scope`);
        return row;
      },
    },
    {
      name: "approvals.resolve",
      description:
        "Resolve an approval. Three decisions: 'approved' (run as-is), " +
        "'rejected' (close permanently), 'approved_with_edits' (run with " +
        "operator-modified args — `editedArgs` REQUIRED). The agent-runtime " +
        "blpop branch ('timed_out') is also accepted for symmetry. " +
        "Idempotent — re-resolving a terminal row leaves prior response " +
        "fields in place.",
      inputSchema: {
        type: "object",
        required: ["approvalId", "status"],
        properties: {
          approvalId: { type: "string" },
          status: {
            type: "string",
            enum: ["approved", "rejected", "timed_out", "approved_with_edits"],
          },
          comment: { type: "string" },
          /**
           * Wave 2 — operator-edited call arguments. Required when
           * status = "approved_with_edits". Must be a JSON object.
           */
          editedArgs: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const id = String(params["approvalId"]);
        const rawStatus = String(params["status"]);
        const isEditPath = rawStatus === "approved_with_edits";
        // Normalize on the wire — the persisted column stays binary
        // (approved/rejected/timed_out). The edit-first marker is the
        // editedArgs column being non-null on the row.
        const persistStatus: "approved" | "rejected" | "timed_out" = isEditPath
          ? "approved"
          : (rawStatus as "approved" | "rejected" | "timed_out");

        let editedArgs: Record<string, unknown> | undefined;
        if (isEditPath) {
          const candidate = params["editedArgs"];
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          ) {
            throw new Error(
              "approvals.resolve: editedArgs (object) required when status='approved_with_edits'",
            );
          }
          editedArgs = candidate as Record<string, unknown>;
        }

        await approvals.resolve({
          scope: tuple(scope),
          approvalId: id,
          status: persistStatus,
          respondedBy: token.mintedByUserId,
          ...(params["comment"] !== undefined ? { comment: params["comment"] as string } : {}),
          ...(editedArgs
            ? {
                editedArgs,
                editedByUserId: token.mintedByUserId ?? null,
              }
            : {}),
        });
        return {
          ok: true,
          approvalId: id,
          status: persistStatus,
          ...(editedArgs ? { editedArgsApplied: true } : {}),
        };
      },
    },

    // ── budgets.* ──────────────────────────────────────────────────
    {
      name: "budgets.list",
      description: "List every budget cap in the token's scope.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const rows = await budgets.list(tuple(scope));
        return { caps: rows };
      },
    },
    {
      name: "budgets.get",
      description: "Fetch a single budget cap by id.",
      inputSchema: {
        type: "object",
        required: ["capId"],
        properties: { capId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["capId"]);
        const row = await budgets.getById(tuple(scope), id);
        if (!row) throw new Error(`budget cap ${id} not found in scope`);
        return row;
      },
    },
    {
      name: "budgets.upsert",
      description:
        "Create or update a budget cap keyed by (scopeType, targetId, period). Destructive — emits cost-gate changes.",
      inputSchema: {
        type: "object",
        required: ["scopeType", "period", "limitCents"],
        properties: {
          scopeType: { type: "string", enum: ["scope", "agent", "user"] },
          targetId: { type: "string" },
          period: { type: "string", enum: ["day", "week", "month"] },
          limitCents: { type: "integer", minimum: 0 },
          runsLimit: { type: "integer", minimum: 0 },
          alertThresholds: { type: "array", items: { type: "integer" } },
          alertWebhookUrl: { type: ["string", "null"] },
          alertEmails: { type: ["string", "null"] },
          enabled: { type: "boolean" },
          tier: { type: "string", enum: ["llm", "skill"] },
          skillSlug: { type: ["string", "null"] },
          agentId: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        return budgets.upsert(tuple(scope), params as any);
      },
    },
    {
      name: "budgets.delete",
      description: "Delete a budget cap by id.",
      inputSchema: {
        type: "object",
        required: ["capId"],
        properties: { capId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["capId"]);
        const ok = await budgets.delete(tuple(scope), id);
        return { ok, capId: id };
      },
    },

    // ── evals.* ────────────────────────────────────────────────────
    {
      name: "evals.list",
      description:
        "List PlatosAgentEval rows in the token's scope. Defaults to last 30 days, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          agentVersionId: { type: "string" },
          criterionId: { type: "string" },
          threadId: { type: "string" },
          runId: { type: "string" },
          sinceDays: { type: "integer", minimum: 1, maximum: 365 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const filters: Record<string, unknown> = {};
        for (const key of [
          "agentId",
          "agentVersionId",
          "criterionId",
          "threadId",
          "runId",
          "sinceDays",
          "limit",
          "offset",
        ]) {
          if (params[key] !== undefined) filters[key] = params[key];
        }
        return evals.list(tuple(scope), filters as any);
      },
    },
    {
      name: "evals.get",
      description: "Fetch a single eval row by id.",
      inputSchema: {
        type: "object",
        required: ["evalId"],
        properties: { evalId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["evalId"]);
        const row = await evals.getById(tuple(scope), id);
        if (!row) throw new Error(`eval ${id} not found in scope`);
        return row;
      },
    },
    {
      name: "evals.run",
      description:
        "Run the judge-LLM pipeline against (agentId, threadId, criterionId). " +
        "Blocks a turn when no self-evaluation guard is violated. Writes a PlatosAgentEval row.",
      inputSchema: {
        type: "object",
        required: ["agentId", "threadId", "criterionId"],
        properties: {
          agentId: { type: "string" },
          threadId: { type: "string" },
          criterionId: { type: "string" },
          messageId: { type: "string" },
          runId: { type: "string" },
          baselineVersionId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        return evals.runJudge(scope as RequestScope, {
          agentId: String(params["agentId"]),
          threadId: String(params["threadId"]),
          criterionId: String(params["criterionId"]),
          ...(params["messageId"] !== undefined
            ? { messageId: params["messageId"] as string }
            : {}),
          ...(params["runId"] !== undefined
            ? { runId: params["runId"] as string }
            : {}),
          ...(params["baselineVersionId"] !== undefined
            ? { baselineVersionId: params["baselineVersionId"] as string }
            : {}),
        });
      },
    },

    // ── artifacts.* ────────────────────────────────────────────────
    // ConversationService.listThreadArtifacts is the only service method
    // that covers artifacts today. `artifacts.get` / `artifacts.delete` don't
    // have dedicated service paths — they'd need new schema-aware helpers.
    {
      name: "artifacts.list",
      description:
        "List artifacts for a thread. `threadId` is required — there is " +
        "no cross-thread paginated artifact view today (artifact rows " +
        "are always nested under a thread). Scope-guarded: cross-scope " +
        "thread ids return `{ error: 'not_found', threadId }` rather " +
        "than the misleading `Thread not found or access denied` " +
        "message that bubbled up from the underlying service.",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        properties: {
          threadId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const threadId = String(params["threadId"]);
        const opts: { limit?: number } = {};
        if (params["limit"] !== undefined) opts.limit = params["limit"] as number;
        try {
          const artifacts = await conversation.listThreadArtifacts(
            threadId,
            scope as RequestScope,
            opts,
          );
          return { artifacts };
        } catch (err: any) {
          // MCPF-followup — surface the cross-scope 404 as a tool-result
          // error rather than letting "Thread not found or access denied"
          // bubble up as a generic INTERNAL_ERROR. The schema validator
          // already covers the "missing threadId" case with -32602.
          const message = err?.message ?? String(err);
          if (/not found|access denied/i.test(message)) {
            return { error: "not_found", threadId };
          }
          throw err;
        }
      },
    },
    // TODO(K.8.artifacts-get): no ArtifactService.getById method today — would
    // need a new scope-guarded read path. Defer.
    // TODO(K.8.artifacts-delete): no ArtifactService.delete either. Defer.

    // ── monitoring.cost.* ──────────────────────────────────────────
    {
      name: "monitoring.cost.daily",
      description:
        "Per-scope daily cost totals (input tokens, output tokens, cents). " +
        "Read from the Redis cost hashes. Pass `date=YYYY-MM-DD` for historical, or leave blank for today.",
      inputSchema: {
        type: "object",
        properties: { date: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const date = params["date"] as string | undefined;
        return cost.getScopeDailyCost(tuple(scope), date);
      },
    },
    {
      name: "monitoring.cost.range",
      description:
        "Aggregate the last N days of per-scope cost counters. Returns totals + perDay breakdown.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 90 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const days = (params["days"] as number | undefined) ?? 7;
        return cost.getScopeCostRange(tuple(scope), days);
      },
    },

    // ── audit.* ────────────────────────────────────────────────────
    {
      name: "audit.tool_calls.query",
      description:
        "Query the tool-call audit ledger. Scope-filtered, paginated.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          agentId: { type: "string" },
          toolName: { type: "string" },
          status: { type: "string" },
          entityId: { type: "string" },
          sinceDays: { type: "integer", minimum: 1, maximum: 365 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const filters: Record<string, unknown> = {};
        for (const key of [
          "threadId",
          "agentId",
          "toolName",
          "status",
          "entityId",
          "sinceDays",
          "limit",
          "offset",
        ]) {
          if (params[key] !== undefined) filters[key] = params[key];
        }
        return toolAudit.list(tuple(scope), filters as any);
      },
    },
    {
      name: "audit.safety_events.query",
      description:
        "Query the safety-event ledger (PII/injection/grounding/exfil/tool_param detectors).",
      inputSchema: {
        type: "object",
        properties: {
          detector: {
            type: "string",
            enum: ["pii", "injection", "grounded", "exfiltration", "tool_param"],
          },
          action: { type: "string", enum: ["flag", "redact", "block", "warn"] },
          threadId: { type: "string" },
          agentId: { type: "string" },
          userId: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          sinceDays: { type: "integer", minimum: 1, maximum: 365 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const filters: Record<string, unknown> = {};
        for (const key of [
          "detector",
          "action",
          "threadId",
          "agentId",
          "userId",
          "severity",
          "sinceDays",
          "limit",
          "offset",
        ]) {
          if (params[key] !== undefined) filters[key] = params[key];
        }
        return safetyEvents.list(tuple(scope), filters as any);
      },
    },

    // ── gdpr.* ─────────────────────────────────────────────────────
    // All three are tier-1 require_approval. They compose the existing
    // memory export + import + deleteAllForUser primitives — there is no
    // dedicated GDPRService today.
    {
      name: "gdpr.export",
      description:
        "Export a user's full memory + knowledge-graph bundle for GDPR DSAR. Destructive flag: defaults to require_approval at platform tier.",
      inputSchema: {
        type: "object",
        required: ["userId"],
        properties: { userId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const userId = String(params["userId"]);
        const scopeTuple = tuple(scope);
        // MCPF-W2 — DSAR must include archived rows. Soft-deleted memories
        // are still the user's data; excluding them would silently violate
        // GDPR's right-of-access guarantee.
        const memories = await memory.list(scopeTuple, {
          userId,
          limit: 10_000,
          includeArchived: true,
        });
        const entities = await graph.getEntities(scopeTuple, { userId, limit: 500 });
        const entityIds = new Set(entities.map((e) => e.id));
        const relationships: Array<Record<string, unknown>> = [];
        for (const e of entities) {
          const details = await graph.getRelationships(scopeTuple, { entityId: e.id });
          if (!details) continue;
          for (const out of details.outbound) {
            if (!entityIds.has(out.to.id)) continue;
            relationships.push({
              fromEntityKey: e.entityKey,
              toEntityKey: out.to.entityKey,
              relationshipType: out.relationship.relationshipType,
              weight: out.relationship.weight,
              metadata: out.relationship.metadata,
              sourceMemoryId: out.relationship.sourceMemoryId,
              createdAt: out.relationship.createdAt,
            });
          }
        }
        return {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          scope: scopeTuple,
          userId,
          memories,
          entities,
          relationships,
        };
      },
    },
    {
      name: "gdpr.import",
      description:
        "Import a previously-exported memory bundle. The caller's scope + userId is authoritative — the bundle's scope fields are advisory. Destructive (replace mode wipes the user's memories first).",
      inputSchema: {
        type: "object",
        required: ["userId", "memories"],
        properties: {
          userId: { type: "string" },
          mode: { type: "string", enum: ["merge", "replace"] },
          memories: {
            type: "array",
            items: { type: "object" },
          },
        },
        additionalProperties: true,
      },
      async execute(params, scope) {
        const userId = String(params["userId"]);
        const mode = (params["mode"] as "merge" | "replace" | undefined) ?? "merge";
        const mems = (params["memories"] as Array<Record<string, unknown>>) ?? [];
        const scopeTuple = tuple(scope);
        if (mode === "replace") {
          await memory.deleteAllForUser(scopeTuple, userId);
        }
        let imported = 0;
        for (const m of mems) {
          try {
            await memory.add(scopeTuple, {
              userId,
              content: String(m["content"] ?? ""),
              ...(m["kind"] !== undefined ? { kind: m["kind"] as any } : {}),
              ...(m["metadata"] !== undefined ? { metadata: m["metadata"] } : {}),
              ...(m["visibility"] !== undefined
                ? { visibility: m["visibility"] as any }
                : {}),
              source: "imported",
            });
            imported += 1;
          } catch {
            /* skip invalid rows — caller sees imported vs. total delta */
          }
        }
        return { ok: true, imported, total: mems.length, mode };
      },
    },
    {
      name: "gdpr.purge",
      description:
        "Delete EVERY memory row for a user in the token's scope. Irreversible. Destructive — defaults to require_approval at platform tier.",
      inputSchema: {
        type: "object",
        required: ["userId"],
        properties: { userId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const userId = String(params["userId"]);
        const count = await memory.deleteAllForUser(tuple(scope), userId);
        return { ok: true, userId, deletedMemories: count };
      },
    },
  ];
}
