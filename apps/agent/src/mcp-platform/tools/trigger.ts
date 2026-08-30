/**
 * Theme K.6 — Platform MCP tools for trigger.dev meta-operations.
 *
 * These wrappers delegate to the webapp's Trigger REST API. Durable runtime
 * consumers use `@trigger.dev/sdk`; these wrappers use plain `fetch` against
 * `PLATOS_TRIGGER_API_URL` with `PLATOS_TRIGGER_API_KEY`. There is NO
 * new agent-side endpoint — the agent is a thin forwarder.
 *
 * Scope note:
 *   The Trigger API key is environment-pinned (one key per trigger
 *   environment). In the Platos deployment model, `PLATOS_TRIGGER_API_KEY`
 *   is the admin-level key for the same scope the agent container runs
 *   against. Tools that need cross-scope isolation rely on the MCP
 *   permission gateway + token scope-pinning to constrain access — the
 *   downstream Trigger API just trusts the key.
 *
 * TODO(K.6.scope-mapper):
 *   Phase-3 review S2 flagged that a scope-tier MCP token pinned to
 *   (orgA, projectA, envA) calling `trigger.runs.list` would receive runs
 *   from whatever env the agent container's `PLATOS_TRIGGER_API_KEY` is
 *   bound to — NOT the caller's pinned scope. Until a (scope -> projectRef,
 *   envSlug, apiKey) mapper exists on the webapp side, every tool in this
 *   file is flagged `requiresAdminTier: true` so only admin-tier tokens
 *   (which explicitly opt into cross-scope behaviour) can reach them.
 *   Scope-tier tokens see zero trigger.* tools in `tools/list`.
 *
 * Tier-1 require_approval:
 *   - trigger.deployments.promote
 *   - trigger.envvars.upsert
 *   - trigger.envvars.delete
 *
 * Deferred (no corresponding webapp endpoint to wrap without inventing
 * one — see `TODO(K.6.*)` markers):
 *   - trigger.tasks.list / trigger.tasks.get (no list endpoint)
 *   - trigger.batches.list / trigger.batches.cancel (no endpoints)
 *   - trigger.queues.resume (webapp has no un-pause endpoint yet)
 *   - trigger.envvars.* (webapp endpoints require projectRef + envSlug,
 *     which the MCP token doesn't carry directly — mapping needs a
 *     webapp-side helper we intentionally don't scaffold here)
 */

import type { McpToolHandler } from "../mcp-router";

function triggerApiBase(): string | null {
  const raw = process.env["PLATOS_TRIGGER_API_URL"];
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function triggerApiKey(): string | null {
  const raw = process.env["PLATOS_TRIGGER_API_KEY"];
  return raw && raw.length > 0 ? raw : null;
}

async function triggerFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const base = triggerApiBase();
  const key = triggerApiKey();
  if (!base || !key) {
    throw new Error(
      "trigger.* tool unavailable: PLATOS_TRIGGER_API_URL + " +
        "PLATOS_TRIGGER_API_KEY must both be set.",
    );
  }
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${key}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const resp = await fetch(`${base}${path}`, {
    ...init,
    headers,
  });
  const text = await resp.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
  }
  if (!resp.ok) {
    const msg =
      typeof body === "object" && body && "error" in (body as any)
        ? String((body as any).error)
        : `trigger API ${resp.status}`;
    throw new Error(`${msg} (${resp.status})`);
  }
  return body;
}

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function buildTriggerToolHandlers(): McpToolHandler[] {
  return [
    // ── runs.* ─────────────────────────────────────────────────────
    {
      name: "trigger.runs.list",
      description:
        "List trigger.dev runs in the current environment. Supports the " +
        "Trigger REST filter set (filter[status], filter[taskIdentifier], " +
        "filter[tag], from, to, period, cursor, limit).",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          taskIdentifier: { type: "string" },
          tag: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          period: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params) {
        const mapped: Record<string, unknown> = {};
        if (params["status"]) mapped["filter[status]"] = params["status"];
        if (params["taskIdentifier"]) mapped["filter[taskIdentifier]"] = params["taskIdentifier"];
        if (params["tag"]) mapped["filter[tag]"] = params["tag"];
        if (params["from"]) mapped["from"] = params["from"];
        if (params["to"]) mapped["to"] = params["to"];
        if (params["period"]) mapped["period"] = params["period"];
        if (params["cursor"]) mapped["page[cursor]"] = params["cursor"];
        if (params["limit"]) mapped["page[size]"] = params["limit"];
        return triggerFetch(`/api/v1/runs${qs(mapped)}`);
      },
    },
    {
      name: "trigger.runs.get",
      description: "Fetch a single trigger.dev run by id.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const runId = String(params["runId"]);
        return triggerFetch(`/api/v1/runs/${encodeURIComponent(runId)}`);
      },
    },
    {
      name: "trigger.runs.replay",
      description: "Replay a completed trigger.dev run. Returns the new run.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const runId = String(params["runId"]);
        return triggerFetch(`/api/v1/runs/${encodeURIComponent(runId)}/replay`, {
          method: "POST",
        });
      },
    },
    {
      name: "trigger.runs.cancel",
      description: "Cancel an in-flight trigger.dev run.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const runId = String(params["runId"]);
        return triggerFetch(`/api/v2/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST",
        });
      },
    },

    // ── tasks.* ────────────────────────────────────────────────────
    // TODO(K.6.tasks-list): webapp has no `/api/v1/tasks` list endpoint.
    // Revisit when one exists (tracked under K.6 follow-up).
    // TODO(K.6.tasks-get): no per-task inspection endpoint either.
    {
      name: "trigger.tasks.trigger",
      description:
        "Trigger a named task with a JSON payload. Returns the run id + " +
        "status. Same surface as `tasks.trigger()` in the Trigger SDK.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: { type: "string" },
          payload: { type: "object" },
          options: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const taskId = String(params["taskId"]);
        const payload = (params["payload"] ?? {}) as Record<string, unknown>;
        // SECURITY (audit C4) — platos.* worker tasks forward payload.scope to
        // admin-token internal callbacks that run a turn UNDER that scope. The
        // MCP admin tier is "cross-scope WITHIN the minting org", not a
        // platform superuser, so a foreign payload.scope would be a cross-ORG
        // escalation. Rebind the scope tuple to the token's own verified scope
        // for any platos.* task — never trust the caller-supplied scope.
        // Match BOTH dot- and dash-namespaced Platos tasks: platos.agent.*
        // AND platos-agent-tool-block / platos-agent-batch / platos-custom-task,
        // which are the real scope-forwarding workers (Fable verify BLOCKER C).
        if (/^platos[.-]/.test(taskId) && payload && typeof payload === "object") {
          const existing = (payload["scope"] ?? {}) as Record<string, unknown>;
          payload["scope"] = {
            ...existing,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          };
        }
        return triggerFetch(
          `/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`,
          {
            method: "POST",
            body: JSON.stringify({
              payload,
              options: params["options"] ?? {},
            }),
          },
        );
      },
    },

    // ── schedules.* ────────────────────────────────────────────────
    {
      name: "trigger.schedules.list",
      description: "List all schedules in the current environment.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params) {
        const q: Record<string, unknown> = {};
        if (params["cursor"]) q["page[cursor]"] = params["cursor"];
        if (params["limit"]) q["page[size]"] = params["limit"];
        return triggerFetch(`/api/v1/schedules${qs(q)}`);
      },
    },
    {
      name: "trigger.schedules.create",
      description: "Create a new schedule row.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["task", "cron"],
        properties: {
          task: { type: "string" },
          cron: { type: "string" },
          timezone: { type: "string" },
          deduplicationKey: { type: "string" },
          externalId: { type: "string" },
          environments: { type: "array", items: { type: "string" } },
        },
        additionalProperties: true,
      },
      async execute(params) {
        return triggerFetch(`/api/v1/schedules`, {
          method: "POST",
          body: JSON.stringify(params),
        });
      },
    },
    {
      name: "trigger.schedules.get",
      description: "Fetch a schedule by id.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["scheduleId"],
        properties: { scheduleId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const id = String(params["scheduleId"]);
        return triggerFetch(`/api/v1/schedules/${encodeURIComponent(id)}`);
      },
    },
    {
      name: "trigger.schedules.delete",
      description: "Delete a schedule by id.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["scheduleId"],
        properties: { scheduleId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const id = String(params["scheduleId"]);
        return triggerFetch(`/api/v1/schedules/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      },
    },
    {
      name: "trigger.schedules.activate",
      description: "Activate a schedule.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["scheduleId"],
        properties: { scheduleId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const id = String(params["scheduleId"]);
        return triggerFetch(`/api/v1/schedules/${encodeURIComponent(id)}/activate`, {
          method: "POST",
        });
      },
    },
    {
      name: "trigger.schedules.deactivate",
      description: "Deactivate a schedule.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["scheduleId"],
        properties: { scheduleId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const id = String(params["scheduleId"]);
        return triggerFetch(`/api/v1/schedules/${encodeURIComponent(id)}/deactivate`, {
          method: "POST",
        });
      },
    },

    // ── batches.* ──────────────────────────────────────────────────
    // TODO(K.6.batches-list): webapp has no `/api/v1/batches` list endpoint.
    {
      name: "trigger.batches.get",
      description: "Fetch a batch-trigger job by id.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["batchId"],
        properties: { batchId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const id = String(params["batchId"]);
        return triggerFetch(`/api/v1/batches/${encodeURIComponent(id)}`);
      },
    },
    // TODO(K.6.batches-cancel): webapp has no batch-cancel endpoint. Revisit
    // when `api.v[12].batches.$batchId.cancel.ts` lands.

    // ── queues.* ───────────────────────────────────────────────────
    {
      name: "trigger.queues.list",
      description: "List queues in the current environment.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params) {
        const q: Record<string, unknown> = {};
        if (params["cursor"]) q["page[cursor]"] = params["cursor"];
        if (params["limit"]) q["page[size]"] = params["limit"];
        return triggerFetch(`/api/v1/queues${qs(q)}`);
      },
    },
    {
      name: "trigger.queues.pause",
      description: "Pause a queue. Future enqueues succeed, dispatches block.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["queueParam"],
        properties: { queueParam: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const q = String(params["queueParam"]);
        return triggerFetch(`/api/v1/queues/${encodeURIComponent(q)}/pause`, {
          method: "POST",
          body: JSON.stringify({ action: "pause" }),
        });
      },
    },
    {
      name: "trigger.queues.resume",
      description: "Resume a paused queue.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["queueParam"],
        properties: { queueParam: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const q = String(params["queueParam"]);
        // Same route, action: "resume" — webapp reuses the pause endpoint
        // as a toggle when the body carries `{ action: "resume" }`.
        return triggerFetch(`/api/v1/queues/${encodeURIComponent(q)}/pause`, {
          method: "POST",
          body: JSON.stringify({ action: "resume" }),
        });
      },
    },

    // ── deployments.* ──────────────────────────────────────────────
    // TODO(K.6.deployments-list): webapp `api.v1.deployments.ts` is POST-only
    // (initialize). Listing goes through the dashboard loader, not the REST
    // API. Skip until the REST list endpoint lands.
    {
      name: "trigger.deployments.get",
      description: "Fetch a deployment by id.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["deploymentId"],
        properties: { deploymentId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const id = String(params["deploymentId"]);
        return triggerFetch(`/api/v1/deployments/${encodeURIComponent(id)}`);
      },
    },
    {
      name: "trigger.deployments.promote",
      description:
        "Promote a specific deployment to the current one for its " +
        "environment. Destructive — defaults to require_approval at " +
        "platform tier.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        required: ["deploymentVersion"],
        properties: { deploymentVersion: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params) {
        const v = String(params["deploymentVersion"]);
        return triggerFetch(
          `/api/v1/deployments/${encodeURIComponent(v)}/promote`,
          { method: "POST" },
        );
      },
    },

    // ── workers.* ──────────────────────────────────────────────────
    {
      name: "trigger.workers.list",
      description: "List background workers registered in the environment.",
      requiresAdminTier: true,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        return triggerFetch(`/api/v1/workers`);
      },
    },

    // ── envvars.* ──────────────────────────────────────────────────
    // TODO(K.6.envvars-*): webapp envvar endpoints are pinned to
    // (projectRef, envSlug) rather than the MCP token's (org, project, env)
    // tuple. Wrapping them from MCP needs a mapping helper that isn't in
    // scope for K.6. Deferred to a K.6 follow-up — permission gateway
    // already reserves tier-1 slots for upsert + delete.
  ];
}
