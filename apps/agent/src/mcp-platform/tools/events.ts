/**
 * Theme K.15 — MCP events.* + notifications.* tool handlers.
 *
 * Turns platform MCP into a bidirectional event bus:
 *
 *   events.subscribe(filters)           — returns a pre-built SSE URL.
 *   events.recent(filters, limit)       — REST catch-up fetch.
 *   notifications.register(...)         — persistent routing rule.
 *   notifications.list / get / update / delete
 *   notifications.test(ruleId)          — synthetic delivery round-trip.
 *
 * Permission tiering (composed in permission-gateway.service.ts):
 *   - notifications.register/update/delete → tier-1 require_approval
 *     (each rule can exfiltrate scoped event data to an external system).
 *   - Everything else                     → tier-4 auto_allow (read-only
 *     or scope-bounded).
 *
 * Scope comes from the verified MCP token and is NEVER read from params —
 * an LLM arg of `organizationId` is ignored, matching the K-gateway
 * invariant established in K.5.
 */

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { McpEventsService, EventScope, RuleFilters, RuleDelivery } from "../events.service";
import { env } from "../../shared/env";

function eventScope(scope: RequestScope): EventScope {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function base64urlJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json, "utf8").toString("base64url");
}

function publicBaseUrl(): string {
  // APP_ORIGIN is the canonical public base; fall back to empty string
  // so we return a relative URL (tested against host+port the SSE client
  // already has). Strip any trailing slash.
  const raw = env.APP_ORIGIN ?? "";
  return raw.replace(/\/$/, "");
}

export interface EventsToolsDeps {
  events: McpEventsService;
}

export function buildEventsToolHandlers(deps: EventsToolsDeps): McpToolHandler[] {
  const { events } = deps;

  return [
    // ── events.subscribe ─────────────────────────────────────────────
    {
      name: "events.subscribe",
      description:
        "Return a pre-built SSE subscription URL for the current scope. " +
        "GET the URL with no extra headers — the `token` query param " +
        "carries the bearer since SSE clients can't set Authorization. " +
        "Filters are encoded into the URL so the server can narrow " +
        "events before writing to the stream. Keepalive ping every 30s.",
      inputSchema: {
        type: "object",
        properties: {
          eventTypes: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact match or glob (`run.*`). Common values: run.completed, run.failed, approval.opened, budget.exceeded, entity.disconnected.",
          },
          subjectIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional — narrow to specific runIds / approvalIds.",
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const filters: RuleFilters = {
          eventTypes: (params["eventTypes"] as string[] | undefined) ?? ["*"],
          ...(params["subjectIds"] !== undefined
            ? { subjectIds: params["subjectIds"] as string[] }
            : {}),
        };
        const filterParam = base64urlJson(filters);
        // We return a URL the SSE client opens directly. The `token`
        // param is the MCP bearer — we don't have it at this layer
        // (only the hash), so the caller substitutes their own token
        // value for `<PLATOS_MCP_TOKEN>`. Document this in the return.
        const base = publicBaseUrl();
        const path = `/mcp/platform/events/subscribe?token=<PLATOS_MCP_TOKEN>&filters=${filterParam}`;
        return {
          subscriptionUrl: base ? `${base}${path}` : path,
          transport: "sse",
          filters,
          scope: eventScope(scope),
          tokenId: token.id,
          instructions:
            "Open this URL with GET and replace <PLATOS_MCP_TOKEN> with your MCP bearer. The server emits `data: <event-json>` frames. First frame is `event: hello`; subsequent frames are `event: message` with the PlatosEvent payload.",
        };
      },
    },

    // ── events.recent ────────────────────────────────────────────────
    {
      name: "events.recent",
      description:
        "Fetch the last N events matching filters in the current scope. " +
        "Useful for reconnect catch-up before opening an SSE stream.",
      inputSchema: {
        type: "object",
        properties: {
          eventTypes: { type: "array", items: { type: "string" } },
          subjectIds: { type: "array", items: { type: "string" } },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const rows = await events.recent(eventScope(scope), {
          ...(params["eventTypes"] !== undefined
            ? { eventTypes: params["eventTypes"] as string[] }
            : {}),
          ...(params["subjectIds"] !== undefined
            ? { subjectIds: params["subjectIds"] as string[] }
            : {}),
          ...(params["limit"] !== undefined ? { limit: params["limit"] as number } : {}),
        });
        return { events: rows, count: rows.length };
      },
    },

    // ── notifications.register ───────────────────────────────────────
    {
      name: "notifications.register",
      description:
        "Create a persistent routing rule. Every event that matches " +
        "`filters` fires `delivery` (Slack webhook / generic HTTP webhook " +
        "/ email / PagerDuty). Tier-1 require_approval — each rule " +
        "exfiltrates scoped event data to an external system.",
      inputSchema: {
        type: "object",
        required: ["name", "filters", "delivery"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          filters: {
            type: "object",
            required: ["eventTypes"],
            properties: {
              eventTypes: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
              },
              subjectIds: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
          delivery: {
            type: "object",
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: ["slack", "webhook", "email", "pagerduty"],
              },
              url: { type: "string" },
              email: { type: "string" },
              integrationKey: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const rule = await events.registerRule(
          eventScope(scope),
          token.mintedByUserId,
          {
            name: String(params["name"]),
            filters: params["filters"] as RuleFilters,
            delivery: params["delivery"] as RuleDelivery,
          },
        );
        return { rule };
      },
    },

    // ── notifications.list ───────────────────────────────────────────
    {
      name: "notifications.list",
      description: "List notification rules in the current scope.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const rules = await events.listRules(eventScope(scope));
        return { rules };
      },
    },

    // ── notifications.get ────────────────────────────────────────────
    {
      name: "notifications.get",
      description: "Fetch a single notification rule by id.",
      inputSchema: {
        type: "object",
        required: ["ruleId"],
        properties: { ruleId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const rule = await events.getRule(eventScope(scope), String(params["ruleId"]));
        if (!rule) throw new Error(`rule ${params["ruleId"]} not found in scope`);
        return rule;
      },
    },

    // ── notifications.update ─────────────────────────────────────────
    {
      name: "notifications.update",
      description:
        "Update an existing notification rule. Tier-1 require_approval.",
      inputSchema: {
        type: "object",
        required: ["ruleId"],
        properties: {
          ruleId: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 120 },
          filters: {
            type: "object",
            required: ["eventTypes"],
            properties: {
              eventTypes: { type: "array", items: { type: "string" }, minItems: 1 },
              subjectIds: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
          delivery: {
            type: "object",
            required: ["type"],
            properties: {
              type: { type: "string", enum: ["slack", "webhook", "email", "pagerduty"] },
              url: { type: "string" },
              email: { type: "string" },
              integrationKey: { type: "string" },
            },
            additionalProperties: false,
          },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["ruleId"]);
        const input: {
          name?: string;
          filters?: RuleFilters;
          delivery?: RuleDelivery;
          enabled?: boolean;
        } = {};
        if (params["name"] !== undefined) input.name = String(params["name"]);
        if (params["filters"] !== undefined)
          input.filters = params["filters"] as RuleFilters;
        if (params["delivery"] !== undefined)
          input.delivery = params["delivery"] as RuleDelivery;
        if (params["enabled"] !== undefined) input.enabled = params["enabled"] as boolean;
        const rule = await events.updateRule(eventScope(scope), id, input);
        return { rule };
      },
    },

    // ── notifications.delete ─────────────────────────────────────────
    {
      name: "notifications.delete",
      description: "Delete a notification rule. Tier-1 require_approval.",
      inputSchema: {
        type: "object",
        required: ["ruleId"],
        properties: { ruleId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const ok = await events.deleteRule(eventScope(scope), String(params["ruleId"]));
        return { ok };
      },
    },

    // ── notifications.test ───────────────────────────────────────────
    {
      name: "notifications.test",
      description:
        "Send a synthetic event through the rule so the operator can " +
        "verify end-to-end wiring (Slack channel, webhook URL, email). " +
        "Does NOT write a PlatosEvent row — delivery is enqueued directly.",
      inputSchema: {
        type: "object",
        required: ["ruleId"],
        properties: { ruleId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        return events.testRule(eventScope(scope), String(params["ruleId"]));
      },
    },
  ];
}
