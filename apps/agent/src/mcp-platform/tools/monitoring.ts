/**
 * Theme MCPF-W6 — Monitoring MCP tools (3 tools).
 *
 * Wraps the read-only monitoring surface so an operator can drive the
 * trace viewer + cost rollups + provider health entirely via MCP.
 *
 * Tools:
 *   • `traces.list`     — list threads with cost rollups (lightweight sibling)
 *   • `traces.get`      — fetch full thread trace (messages + spans + rollup)
 *   • `health.check`    — provider health probe (single or all-in-scope)
 *
 * All three are read-only. No approval gates. No audit rows (audit
 * pipeline is for mutations only — Wave 1-5 lesson).
 */

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import { requireOperator } from "../../auth/scope.guard";
import type { TraceService } from "../../monitoring/trace.service";
import type { ProviderHealthService } from "../../auth/provider-health.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function buildMonitoringToolHandlers(deps: {
  traces: TraceService;
  providerHealth: ProviderHealthService;
  prisma: any;
}): McpToolHandler[] {
  const { traces, providerHealth } = deps;

  return [
    {
      name: "traces.list",
      description:
        "List threads with cost / token / tool-call rollups. " +
        "One row per thread, with no spans or message text. Useful for 'show me the most " +
        "expensive threads in the last 24h' or 'list active threads " +
        "for agent X'. Filters by optional `agentId` + `since`.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          since: { type: "string", format: "date-time" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0, maximum: 10000 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        const opts: { agentId?: string; since?: Date; limit?: number; offset?: number } = {};
        if (params["agentId"]) opts.agentId = String(params["agentId"]);
        if (params["since"]) {
          const since = new Date(String(params["since"]));
          if (!isNaN(since.getTime())) opts.since = since;
        }
        if (typeof params["limit"] === "number") opts.limit = params["limit"];
        if (typeof params["offset"] === "number") opts.offset = params["offset"];
        return traces.listTraces(tuple(reqScope), opts);
      },
    },
    {
      name: "traces.get",
      description:
        "Fetch a full thread trace including messages, spans, " +
        "timeline, and rollup. Cross-scope ids return `null`.",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        properties: { threadId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope, _token, abortSignal) {
        const threadId = String(params["threadId"]);
        const trace = await traces.buildThreadTrace(tuple(scope), threadId, abortSignal);
        if (!trace) return { error: "not_found", threadId };
        return trace;
      },
    },
    {
      name: "health.check",
      description:
        "Probe LLM provider health. Pass `provider` (e.g. 'anthropic', " +
        "'openai') for a single probe; omit it to probe every provider " +
        "configured in scope. Each result reports status (healthy / " +
        "invalid_key / error / not_configured), latency, and which " +
        "required env vars are set. Cached 5 minutes server-side.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        requireOperator(reqScope);
        const provider = params["provider"] as string | undefined;
        if (provider) {
          const result = await providerHealth.testProvider(tuple(reqScope), provider);
          return { results: [result] };
        }
        const results = await providerHealth.testAllProviders(tuple(reqScope));
        return { results };
      },
    },
  ];
}
