// WIN-256 — REST/MCP capability row → owning bounded context.
//
// ADR M0.3 §1 is the allow-list and the only authority. Its cutting rule is
// that every canonical row has exactly ONE context permitted to write it, so a
// capability row's owner is decided by the canonical rows its handler WRITES —
// never by its URL prefix. This module holds that decision as data, beside
// `table-ownership.mjs` (which holds §1's SOLE WRITER column) and
// `boundary-rules.mjs` (which holds §1's context registry), so the generator,
// the audit and the tests all read one source of truth.
//
// WHY THIS FILE EXISTS. `scripts/capability-matrix.mjs` used to derive `owner`
// from a URL-prefix regex and fall back to the string "unassigned (review)" for
// anything unmatched. 31 of the 300 REST rows landed on that fallback, and a
// further 11 carried the hedged label "durable-runtime / internal-callbacks",
// which is not a name ADR M0.3 §1 defines. WIN-256 resolves all 42 against the
// frozen `origin/main` oracle and removes the fallback: an unresolved path now
// throws, so "unassigned (review)" is not producible.
//
// HANDLER CITATIONS. `evidence` cites the oracle handler as `<basename>:<line>`
// at ORACLE below. Every basename cited here is unique in that tree. Basenames
// rather than full paths because one cited source directory carries a reserved
// term from the repository vocabulary boundary (WIN-292), and restating it here
// would buy a manifest exception that records no decision about code.
//
// WHAT IS AND IS NOT ENFORCED. `validateOwners` enforces, per row: a permitted
// owner name; the platform-transport admission rule; and — for the 42 rows with
// recorded evidence — that the owner equals the single §1 write-owner of every
// canonical row the handler writes. It does NOT certify the 258 rows whose
// owner still comes from `PATH_CONTEXT_RULES`; those are marked
// `ownerSource: "path-prefix"` in the artifact so the difference is visible
// rather than implied. Recorded `reads` are evidence, not a constraint: the ADR
// restricts writes and leaves reads unrestricted (`table-ownership.mjs`), so
// enforcing a read rule here would assert a property the ADR does not hold.

import { CONTEXT_NAMES } from "./boundary-rules.mjs";
import { OWNER } from "./table-ownership.mjs";

/** The frozen main oracle every `evidence` line below was read from. */
export const ORACLE = "89c12b8";

/**
 * The one owner value that is NOT a bounded context.
 *
 * Angle brackets follow the convention `table-ownership.mjs` already uses for
 * `Event: "<kernel-outbox-adapter>"` — a row whose writer is deliberately not
 * one of the contexts. ADMISSION RULE, enforced in `validateOwners`:
 *
 *   a row may carry this value only if (1) its id is in
 *   PLATFORM_TRANSPORT_ROWS, and (2) its recorded evidence shows it writes and
 *   reads ZERO canonical rows.
 *
 * Both directions are checked: a row in the enumeration that touches a
 * canonical row is refused, and a row outside the enumeration may not carry the
 * value. PLATFORM_TRANSPORT_ROWS is pinned by count, so widening it is a
 * deliberate edit to two places and not a silent drift. It exists for the
 * handful of endpoints that describe the process or the API itself — liveness,
 * process metrics, API/transport self-description — and owning no domain state
 * is what makes them ownerless, not their being hard to place.
 */
export const PLATFORM_TRANSPORT = "<platform-transport>";

/**
 * The owner vocabulary: ADR M0.3 §1's 18 numbered rows.
 *
 * §1 numbers 17 domain contexts plus `durable-runtime` (row 11, the
 * infrastructure adapter-context). `CONTEXT_NAMES` is already the registry for
 * the 17 — `boundary-rules.mjs` rule (l) rejects any directory under
 * `packages/contexts/` that is not one of them — and `durable-runtime` is
 * deliberately absent from it because §4 lists that one under `adapters/`.
 * Deriving the list rather than restating it keeps the two enforcers from
 * drifting apart. `platform-kernel` is NOT here: §1 gives it no capabilities
 * and no rows, so no route can be owned by it.
 */
export const ADR_M03_CONTEXTS = Object.freeze(
  [...CONTEXT_NAMES, "durable-runtime"].sort(),
);

/** Every value `owner` may take, anywhere in the capability matrix. */
export const PERMITTED_OWNERS = Object.freeze(
  [...ADR_M03_CONTEXTS, PLATFORM_TRANSPORT].sort(),
);

/**
 * The value WIN-256 retires. `PERMITTED_OWNERS` already excludes it, but it is
 * named here so the audit rejects it with its own message rather than folding
 * it into the generic not-an-ADR-context failure — a reader who hits this rule
 * learns which criterion they have walked back into.
 */
export const RETIRED_OWNER_PLACEHOLDER = "unassigned (review)";

/** The exact rows admitted to PLATFORM_TRANSPORT. Pinned by count below. */
export const PLATFORM_TRANSPORT_ROWS = Object.freeze([
  "GET /api/health",
  "GET /api/v1/agent/connect",
  "GET /api/v1/agent/openapi.json",
  "GET /metrics",
  "GET /openapi",
]);

/** Pin. A sixth platform-transport row must edit this number on purpose. */
export const PLATFORM_TRANSPORT_ROW_COUNT = 5;

/**
 * Rows resolved against the oracle, one entry each.
 *
 *   owner     — the ADR §1 context (or PLATFORM_TRANSPORT).
 *   writes    — canonical rows the handler WRITES. Decides `owner` under §1.
 *   reads     — canonical rows it reads. Evidence; the ADR leaves reads open.
 *   rationale — why this owner, in the ADR's own terms.
 *   evidence  — `<basename>:<line>` of the handler at ORACLE.
 */
export const ROUTE_OWNERSHIP = Object.freeze({
  // ── platform-transport: liveness, process metrics, self-description ───────
  "GET /api/health": {
    owner: PLATFORM_TRANSPORT,
    writes: [],
    reads: [],
    rationale:
      "Liveness only: returns status/service/timestamp and PLATOS_VERSION from env. No store of any kind, so no context writes or reads through it.",
    evidence: "health.controller.ts:7",
  },
  "GET /metrics": {
    owner: PLATFORM_TRANSPORT,
    writes: [],
    reads: [],
    rationale:
      "Prometheus scrape of the in-process prom-client default registry (metrics.service.ts:24). Counters live in process memory; the handler reaches no store.",
    evidence: "metrics.controller.ts:18",
  },
  "GET /openapi": {
    owner: PLATFORM_TRANSPORT,
    writes: [],
    reads: [],
    rationale: "Serves the API's own OpenAPI description. No store.",
    evidence: "openapi.controller.ts:25",
  },
  "GET /api/v1/agent/openapi.json": {
    owner: PLATFORM_TRANSPORT,
    writes: [],
    reads: [],
    rationale:
      "The same OpenAPI description under the versioned prefix. No store.",
    evidence: "openapi.controller.ts:18",
  },
  "GET /api/v1/agent/connect": {
    owner: PLATFORM_TRANSPORT,
    writes: [],
    reads: [],
    rationale:
      "Transport self-description: echoes the websocket/REST/tool-sync URLs from env and the already-resolved request scope, plus the auth header names. It reaches no store, and no context owns the directory of the API's own endpoints — this is the same family as the OpenAPI rows, and is REST_ONLY only because the example values are filled from the caller's scope.",
    evidence: "agent.controller.ts:1902",
  },

  // ── governance — ADR §1 row 14 owns EvalCriterion / GoldenSet / AgentEval ─
  "POST /api/v1/agent/eval-criteria": {
    owner: "governance",
    writes: ["EvalCriterion"],
    reads: [],
    rationale: "CriterionService.create writes EvalCriterion (criterion.service.ts:65).",
    evidence: "agent.controller.ts:6099",
  },
  "GET /api/v1/agent/eval-criteria": {
    owner: "governance",
    writes: [],
    reads: ["EvalCriterion"],
    rationale: "CriterionService.listPage reads EvalCriterion; governance is its §1 write-owner.",
    evidence: "agent.controller.ts:6110",
  },
  "GET /api/v1/agent/eval-criteria/:criterionId": {
    owner: "governance",
    writes: [],
    reads: ["EvalCriterion"],
    rationale: "CriterionService.findById reads EvalCriterion; governance is its §1 write-owner.",
    evidence: "agent.controller.ts:6142",
  },
  "PATCH /api/v1/agent/eval-criteria/:criterionId": {
    owner: "governance",
    writes: ["EvalCriterion"],
    reads: [],
    rationale: "CriterionService.update writes EvalCriterion.",
    evidence: "agent.controller.ts:6153",
  },
  "DELETE /api/v1/agent/eval-criteria/:criterionId": {
    owner: "governance",
    writes: ["EvalCriterion"],
    reads: [],
    rationale: "CriterionService.remove deletes EvalCriterion.",
    evidence: "agent.controller.ts:6168",
  },
  "POST /api/v1/agent/golden-sets": {
    owner: "governance",
    writes: ["GoldenSet"],
    reads: [],
    rationale: "GoldenSetService.create writes GoldenSet (golden-set.service.ts:100).",
    evidence: "agent.controller.ts:6286",
  },
  "GET /api/v1/agent/golden-sets": {
    owner: "governance",
    writes: [],
    reads: ["GoldenSet"],
    rationale: "GoldenSetService.list reads GoldenSet; governance is its §1 write-owner.",
    evidence: "agent.controller.ts:6297",
  },
  "GET /api/v1/agent/golden-sets/:goldenSetId": {
    owner: "governance",
    writes: [],
    reads: ["GoldenSet"],
    rationale: "GoldenSetService.findById reads GoldenSet; governance is its §1 write-owner.",
    evidence: "agent.controller.ts:6309",
  },
  "PATCH /api/v1/agent/golden-sets/:goldenSetId": {
    owner: "governance",
    writes: ["GoldenSet"],
    reads: [],
    rationale: "GoldenSetService.update writes GoldenSet.",
    evidence: "agent.controller.ts:6323",
  },
  "DELETE /api/v1/agent/golden-sets/:goldenSetId": {
    owner: "governance",
    writes: ["GoldenSet"],
    reads: [],
    rationale: "GoldenSetService.remove deletes GoldenSet.",
    evidence: "agent.controller.ts:6342",
  },
  "POST /api/v1/agent/golden-sets/:goldenSetId/run": {
    owner: "governance",
    writes: ["AgentEval"],
    reads: ["GoldenSet", "Agent", "AgentVersion", "Thread", "Turn"],
    rationale:
      "GoldenSetService.run fans out through EvalService.runJudge and writes AgentEval (golden-set.service.ts:242, eval.service.ts). Every write is governance-owned; Thread/Turn/Agent/AgentVersion are read-only inputs to the judge.",
    evidence: "agent.controller.ts:6359",
  },

  // ── agents — ADR §1 row 5 owns Agent / AgentVersion / PostmanTemplate ─────
  "GET /api/v1/agent/feature-flags": {
    owner: "agents",
    writes: [],
    reads: [],
    rationale:
      "Introspects the in-code feature-flag key registry (feature-flag-registry.ts), which is the schema for the Agent.featureFlags column and the validator the editor calls before PATCH /api/v1/agent/agents/:agentId/feature-flags writes it (agent.controller.ts:1778). Agent is agents-owned, so its key registry is too. Reaches no store itself.",
    evidence: "agent.controller.ts:1812",
  },
  "GET /api/v1/agent/postman-templates": {
    owner: "agents",
    writes: [],
    reads: ["PostmanTemplate"],
    rationale: "Reads PostmanTemplate; agents is its §1 write-owner.",
    evidence: "agent.controller.ts:6452",
  },
  "POST /api/v1/agent/postman-templates": {
    owner: "agents",
    writes: ["PostmanTemplate"],
    reads: ["AgentBinding"],
    rationale:
      "Writes PostmanTemplate after an AgentBinding scope check. Both rows are agents-owned.",
    evidence: "agent.controller.ts:6499",
  },
  "PUT /api/v1/agent/postman-templates/:id": {
    owner: "agents",
    writes: ["PostmanTemplate"],
    reads: [],
    rationale: "Writes PostmanTemplate only.",
    evidence: "agent.controller.ts:6542",
  },
  "DELETE /api/v1/agent/postman-templates/:id": {
    owner: "agents",
    writes: ["PostmanTemplate"],
    reads: [],
    rationale: "Deletes PostmanTemplate only.",
    evidence: "agent.controller.ts:6580",
  },
  "GET /api/v1/agent/prompt/defaults": {
    owner: "agents",
    writes: [],
    reads: [],
    rationale:
      "PromptBuilderService.getDefaultBlocks is pure (prompt-builder.service.ts holds no store client). The blocks it seeds are persisted in AgentVersion.systemPrompt, an agents-owned row, so the builder is agent authoring.",
    evidence: "agent.controller.ts:5936",
  },
  "POST /api/v1/agent/prompt/preview": {
    owner: "agents",
    writes: [],
    reads: [],
    rationale:
      "PromptBuilderService.preview is pure. Same authoring surface as prompt/defaults; the blocks belong to AgentVersion.systemPrompt.",
    evidence: "agent.controller.ts:5942",
  },
  "POST /api/v1/agent/prompt/assemble": {
    owner: "agents",
    writes: [],
    reads: ["Skill"],
    rationale:
      "PromptBuilderService.assembleAsync over the same agent-authored blocks. A retrieval block dispatches SkillRuntimeService.invokeTool, which reads Skill through SkillRegistryService and records usage only in Redis rollups (cost.service.ts:832) — no canonical write. ADR §1 row 5 lists `skills` in the agents dependency allow-list, so the read is DAG-legal.",
    evidence: "agent.controller.ts:5956",
  },

  // ── conversations — ADR §1 row 16 owns Thread / Turn / Step / PostmanExecution
  "POST /api/v1/agent/postman-templates/:id/execute": {
    owner: "conversations",
    writes: ["PostmanExecution"],
    reads: ["PostmanTemplate", "OrganizationMembership", "EndUser", "Thread", "Turn"],
    rationale:
      "The one postman row that is NOT agents. It writes PostmanExecution (agent.controller.ts:6857 create, 6752 update) and runs a turn through TurnDispatchService.collectTurn; PostmanTemplate is only read here. ADR §1 splits the pair deliberately — PostmanTemplate is agents (row 5), PostmanExecution is conversations (row 16).",
    evidence: "agent.controller.ts:6591",
  },
  "POST /api/v1/agent/internal/durable-turn": {
    owner: "conversations",
    writes: ["Thread", "Turn"],
    reads: ["AgentBinding"],
    rationale:
      "AgentTaskService.executeStreamingTurn — the turn engine itself (agent-task.service.ts).",
    evidence: "agent.controller.ts:4739",
  },
  "POST /api/v1/agent/internal/employee-run": {
    owner: "conversations",
    writes: ["Thread", "Turn"],
    reads: ["AgentBinding"],
    rationale: "AgentTaskService.executeNonStreamingTurn — the turn engine.",
    evidence: "agent.controller.ts:4896",
  },
  "POST /api/v1/agent/internal/subagent-report": {
    owner: "conversations",
    writes: ["Thread", "Turn"],
    reads: ["AgentBinding"],
    rationale: "AgentTaskService.executeStreamingTurn — the turn engine.",
    evidence: "agent.controller.ts:4962",
  },
  "POST /api/v1/agent/internal/compaction": {
    owner: "conversations",
    writes: ["Thread", "Turn"],
    reads: ["Memory"],
    rationale:
      "AgentTaskService.runCompaction rewrites thread history; Memory is a read-only input.",
    evidence: "agent.controller.ts:4607",
  },
  "POST /api/v1/agent/internal/chat/reap-sessions": {
    owner: "conversations",
    writes: ["Thread"],
    reads: [],
    rationale: "ConversationService.reapChatSessions closes stale Threads (conversation.service.ts).",
    evidence: "agent.controller.ts:4707",
  },
  "POST /internal/subagent-turn": {
    owner: "conversations",
    writes: ["Thread", "Turn"],
    reads: ["AgentBinding"],
    rationale:
      "ConversationService.createThread then AgentTaskService.executeNonStreamingTurn — the turn engine, reached over the internal callback surface.",
    evidence: "internal-execute-tool.controller.ts:327",
  },

  // ── tools — ADR §1 row 7 owns ToolCall / ToolCallAudit ────────────────────
  "GET /api/v1/agent/tool-calls": {
    owner: "tools",
    writes: [],
    reads: ["ToolCallAudit"],
    rationale:
      "ToolAuditService.list reads ToolCallAudit (tool-audit.service.ts); tools is its §1 write-owner per §7 decision 4 — the executor owns the execution record.",
    evidence: "agent.controller.ts:4404",
  },
  "GET /api/v1/agent/tool-calls/:toolCallId": {
    owner: "tools",
    writes: [],
    reads: ["ToolCallAudit"],
    rationale: "ToolAuditService.getById reads ToolCallAudit; tools is its §1 write-owner.",
    evidence: "agent.controller.ts:4441",
  },
  "POST /api/v1/agent/tool-calls/:toolCallId/replay": {
    owner: "tools",
    writes: ["ToolCallAudit", "ToolHealth"],
    reads: ["ToolCallAudit", "Credential", "Entity", "EnvironmentEntityTool"],
    rationale:
      "Re-invokes ToolExecutorService.execute, which appends its own audit row and stamps ToolHealth (tool-executor.service.ts). Both writes are tools-owned.",
    evidence: "agent.controller.ts:4462",
  },
  "POST /internal/execute-tool": {
    owner: "tools",
    writes: ["ToolCallAudit", "ToolHealth"],
    reads: ["Credential", "Entity", "EnvironmentEntityTool", "McpOidcSession"],
    rationale:
      "ToolExecutorService.execute over the internal callback surface. The writes are the execution record and tool health, both tools-owned.",
    evidence: "internal-execute-tool.controller.ts:112",
  },

  // ── the remaining single-owner rows ──────────────────────────────────────
  "POST /api/v1/agent/durable-approvals/:token/resolve": {
    owner: "jobs",
    writes: ["AgentApproval"],
    reads: ["AgentApproval"],
    rationale:
      "Mirrors the approvals ledger through MonitoringApprovalsService.resolve, whose only canonical row is AgentApproval (approvals.service.ts:121) — ADR §1 row 15. Completing the external durable pause is an adapter call, not a canonical write, so it does not move the owner.",
    evidence: "agent.controller.ts:1028",
  },
  "GET /api/v1/agent/secrets/status": {
    owner: "secrets",
    writes: [],
    reads: [],
    rationale:
      "Reports SecretsService.isProductionReady() and MessageCryptoService.status(). ADR §1 row 3 defines `secrets` as exactly those two services — the encryption boundary — so this is its readiness probe. Neither reaches a canonical row.",
    evidence: "agent.controller.ts:5918",
  },
  "POST /api/v1/agent/internal/budget-alert": {
    owner: "cost-monitoring",
    writes: ["BudgetThresholdEvent", "AlertDelivery"],
    reads: ["Budget"],
    rationale:
      "BudgetService.deliverThresholdEvent writes BudgetThresholdEvent and AlertDelivery (budget.service.ts). Both are cost-monitoring, ADR §1 row 13.",
    evidence: "agent.controller.ts:5852",
  },
  "POST /api/v1/agent/internal/skill-run": {
    owner: "skills",
    writes: [],
    reads: ["Skill"],
    rationale:
      "SkillRuntimeService.invokeTool resolves the skill through SkillRegistryService (Skill, ADR §1 row 6) and records usage only in Redis rollups (cost.service.ts:832) — no canonical write.",
    evidence: "agent.controller.ts:5073",
  },
  "POST /internal/env/invalidate": {
    owner: "providers",
    writes: [],
    reads: ["ProviderKey", "Credential", "EnvironmentVariable"],
    rationale:
      "Drops ScopedEnvService's cache. ADR §3 places that service in `providers`, beside PROVIDER_MANIFESTS, when provider-health leaves auth. The cache it clears is over ProviderKey plus the secrets-owned rows the scoped env resolves; the handler writes nothing.",
    evidence: "internal-execute-tool.controller.ts:61",
  },
  "GET /api/v1/agent/activity/recent": {
    owner: "observability",
    writes: [],
    reads: ["AdminAudit", "Entity", "Memory", "SafetyEvent", "Thread"],
    rationale:
      "An operator activity feed that writes nothing and reads across five contexts. ADR §1 row 12 is the only one whose charter is a cross-context analytical projection, and AdminAudit — one of the five — is its own canonical row. NOTE the V1 consequence: §1 row 12 is fed by outbox envelopes and may depend only on tenancy, and §1 row 16 says no context imports conversations, so this feed must be served from the observability projection rather than by reading Thread/Memory/SafetyEvent directly. Recorded here, carried by the M2 extraction.",
    evidence: "agent.controller.ts:5544",
  },
  "GET /api/v1/agent/internal/performance-evidence/:requestId": {
    owner: "observability",
    writes: [],
    reads: [],
    rationale:
      "Returns per-request query timings captured in process memory by PerformanceEvidenceService (Maps, not a store). Telemetry over the request path is ADR §1 row 12's charter; nothing about it belongs to the durable-runtime adapter it was previously grouped under.",
    evidence: "performance-evidence.controller.ts:16",
  },
});

/** Pin. Every row above was read from the oracle; a 43rd needs the same. */
export const ORACLE_DERIVED_ROW_COUNT = 42;

/**
 * URL-prefix derivation for the rows WIN-256 did not individually resolve.
 *
 * Carried over unchanged from `capability-matrix.mjs`, minus its
 * "unassigned (review)" fallback: `ownerForRoute` now throws when nothing
 * matches. Rows resolved here are stamped `ownerSource: "path-prefix"` in the
 * artifact, because a prefix is a guess about a URL and not evidence about a
 * handler.
 */
export const PATH_CONTEXT_RULES = Object.freeze([
  [/\/access-key|\/oauth|\/session|\/guest|\/auth/, "identity-access"],
  [/\/orgs|\/projects|\/environments|\/entities|\/entity/, "tenancy"],
  [/\/providers|\/models|\/keys/, "providers"],
  [/\/agents|\/agent-versions|\/clusters|\/canary/, "agents"],
  [/\/skills/, "skills"],
  [/\/tools|\/mcp/, "tools"],
  [/\/memory|\/graph/, "memory"],
  [/\/channels|\/channel-apps/, "channels"],
  [/\/threads|\/messages|\/turns|\/stream/, "conversations"],
  [/\/jobs|\/approvals|\/schedules|\/batch/, "jobs"],
  [/\/budgets|\/cost|\/monitoring/, "cost-monitoring"],
  [/\/evals|\/safety|\/ratings|\/governance/, "governance"],
  [/\/files|\/attachments|\/artifacts/, "files"],
  [/\/privacy|\/erasure|\/gdpr/, "privacy"],
]);

/**
 * Resolve one REST row. Evidence first, prefix second, and THROW when neither
 * resolves — the property WIN-256 turns on: no fallback string can be emitted.
 */
export function ownerForRoute(id, path) {
  const recorded = ROUTE_OWNERSHIP[id];
  if (recorded) return { owner: recorded.owner, ownerSource: "oracle-derived", ...recorded };
  for (const [re, context] of PATH_CONTEXT_RULES) {
    if (re.test(path)) return { owner: context, ownerSource: "path-prefix" };
  }
  throw new Error(
    `route-ownership: no owner for ${id} — resolve it against the ${ORACLE} oracle and add it to ROUTE_OWNERSHIP (ADR M0.3 §1 decides the owner by what the handler WRITES). There is no fallback value.`,
  );
}

/** MCP tools: ADR §1 row 7 merged tool-gateway and mcp-platform into `tools`. */
export const MCP_TOOL_OWNER = "tools";

/**
 * Validate the owner column of a built matrix. Returns a list of failures, each
 * naming the offending row id and the rule that rejected it, so two different
 * defects never produce the same message.
 */
export function validateOwners(restRows, mcpRows) {
  const errors = [];
  const permitted = new Set(PERMITTED_OWNERS);
  const transportRows = new Set(PLATFORM_TRANSPORT_ROWS);

  if (PLATFORM_TRANSPORT_ROWS.length !== PLATFORM_TRANSPORT_ROW_COUNT) {
    errors.push(
      `platform-transport-count: PLATFORM_TRANSPORT_ROWS holds ${PLATFORM_TRANSPORT_ROWS.length} ids, pinned at ${PLATFORM_TRANSPORT_ROW_COUNT}`,
    );
  }
  const recordedIds = Object.keys(ROUTE_OWNERSHIP);
  if (recordedIds.length !== ORACLE_DERIVED_ROW_COUNT) {
    errors.push(
      `oracle-derived-count: ROUTE_OWNERSHIP holds ${recordedIds.length} rows, pinned at ${ORACLE_DERIVED_ROW_COUNT}`,
    );
  }

  for (const row of [...restRows, ...mcpRows]) {
    const id = row.id;

    // (1) present, non-empty, and a name ADR M0.3 §1 defines.
    if (typeof row.owner !== "string" || row.owner.trim() === "") {
      errors.push(`owner-missing: ${id} has no owner`);
      continue;
    }
    if (row.owner === RETIRED_OWNER_PLACEHOLDER) {
      errors.push(
        `owner-is-retired-placeholder: ${id} carries the placeholder WIN-256 retired; resolve it against the ${ORACLE} oracle and record it in ROUTE_OWNERSHIP`,
      );
      continue;
    }
    if (!permitted.has(row.owner)) {
      errors.push(
        `owner-not-in-adr: ${id} names "${row.owner}", which is not an ADR M0.3 §1 context (permitted: ${PERMITTED_OWNERS.join(", ")})`,
      );
      continue;
    }

    // (2) the platform-transport admission rule, checked both ways.
    const claimsTransport = row.owner === PLATFORM_TRANSPORT;
    if (claimsTransport && !transportRows.has(id)) {
      errors.push(
        `transport-not-admitted: ${id} claims ${PLATFORM_TRANSPORT} but is not in PLATFORM_TRANSPORT_ROWS`,
      );
    }
    if (!claimsTransport && transportRows.has(id)) {
      errors.push(
        `transport-row-reassigned: ${id} is in PLATFORM_TRANSPORT_ROWS but names "${row.owner}"`,
      );
    }

    const writes = Array.isArray(row.canonicalWrites) ? row.canonicalWrites : null;
    const reads = Array.isArray(row.canonicalReads) ? row.canonicalReads : null;

    if (claimsTransport) {
      if (writes === null || reads === null) {
        errors.push(
          `transport-evidence-missing: ${id} claims ${PLATFORM_TRANSPORT} without recorded canonicalWrites/canonicalReads`,
        );
      } else if (writes.length > 0 || reads.length > 0) {
        errors.push(
          `transport-touches-canonical-row: ${id} claims ${PLATFORM_TRANSPORT} but records writes [${writes.join(", ")}] and reads [${reads.join(", ")}]; a row that touches a canonical row has a context that owns it`,
        );
      }
    }

    // (3) every recorded model name must be a real canonical row.
    for (const [field, list] of [["canonicalWrites", writes], ["canonicalReads", reads]]) {
      for (const model of list ?? []) {
        if (!(model in OWNER)) {
          errors.push(
            `unknown-canonical-row: ${id} lists "${model}" in ${field}, which is not a row in table-ownership.mjs`,
          );
        }
      }
    }

    // (4) ADR §1's cutting rule: the writer decides the owner.
    if (writes && writes.length > 0) {
      const owners = [...new Set(writes.map((m) => OWNER[m]).filter(Boolean))];
      if (owners.length > 1) {
        errors.push(
          `write-owner-split: ${id} writes rows owned by ${owners.join(" and ")}; ADR M0.3 §1 permits exactly one writer per canonical row`,
        );
      } else if (owners.length === 1 && owners[0] !== row.owner) {
        errors.push(
          `write-owner-mismatch: ${id} names "${row.owner}" but writes ${writes.join(", ")}, owned by "${owners[0]}" in table-ownership.mjs`,
        );
      }
    }

    // (5) a row that writes nothing must say why it is owned where it is.
    if (row.ownerSource === "oracle-derived" && (!writes || writes.length === 0)) {
      if (typeof row.ownerRationale !== "string" || row.ownerRationale.trim() === "") {
        errors.push(
          `rationale-missing: ${id} writes no canonical row, so its owner rests on a rationale, and none is recorded`,
        );
      }
    }
  }
  return errors;
}
