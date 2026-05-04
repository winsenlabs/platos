/**
 * Server-side client for the platos-agent API.
 * Used by Remix loaders/actions to fetch data from the NestJS agent service.
 *
 * This runs server-side only (note the .server.ts suffix).
 * The agent API is on the internal network (localhost:3100 in dev,
 * agent:3100 in Docker Compose).
 *
 * Scope-based contract:
 *   Every call sends four `X-Platos-*` headers so the agent service's
 *   `ScopeGuard` can resolve (organizationId, projectId, environmentId, userId).
 *   There is no implicit `"default"` org any more — callers must pass the
 *   resolved IDs from the Remix route.
 */

const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

export interface AgentScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}

interface FetchOptions {
  method?: string;
  body?: unknown;
}

async function agentFetch<T = unknown>(
  path: string,
  scope: AgentScope,
  opts: FetchOptions = {}
): Promise<T> {
  const url = `${AGENT_API_URL}${path}`;
  const init: RequestInit = {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
    },
  };

  if (opts.body && opts.method !== "GET") {
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Platos Agent API error: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

/** List agents in a scope */
export async function listAgents(scope: AgentScope) {
  return agentFetch<{ agents: any[] }>("/api/v1/agent/agents", scope);
}

/** Get agent config */
export async function getAgent(agentId: string, scope: AgentScope) {
  return agentFetch<any>(`/api/v1/agent/agents/${agentId}`, scope);
}

/** List threads for a user/scope, optionally filtered by agent and Theme F.10 metadata. */
export async function listThreads(
  scope: AgentScope,
  options?:
    | string
    | {
        agentId?: string;
        status?: string;
        tag?: string;
        pinned?: boolean;
        archived?: boolean | "only";
        limit?: number;
        offset?: number;
        /** When true, skips the userId filter — returns all threads in scope
         *  regardless of which end-user owns them. Used by the operator
         *  conversations list where you want to see every thread for the agent. */
        allUsers?: boolean;
      }
) {
  // Backwards-compat: callers that still pass a raw agentId string continue to work.
  const opts = typeof options === "string" ? { agentId: options } : options ?? {};
  const params = new URLSearchParams();
  if (opts.agentId) params.set("agentId", opts.agentId);
  if (opts.status) params.set("status", opts.status);
  if (opts.tag) params.set("tag", opts.tag);
  if (opts.pinned === true) params.set("pinned", "true");
  if (opts.archived === "only") params.set("archived", "only");
  else if (opts.archived === true) params.set("archived", "true");
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
  if (typeof opts.offset === "number") params.set("offset", String(opts.offset));
  if (opts.allUsers === true) params.set("allUsers", "true");
  const qs = params.toString();
  return agentFetch<{ threads: any[]; total: number }>(
    `/api/v1/agent/threads${qs ? `?${qs}` : ""}`,
    scope
  );
}

/** Theme F.10 — replace the tag list on a thread. Tags normalised server-side. */
export async function setThreadTags(threadId: string, scope: AgentScope, tags: string[]) {
  return agentFetch<any>(`/api/v1/agent/threads/${threadId}/tags`, scope, {
    method: "POST",
    body: { tags },
  });
}

/** Theme F.10 — toggle pin state (omit `pinned` to flip, pass explicitly to force). */
export async function toggleThreadPin(
  threadId: string,
  scope: AgentScope,
  pinned?: boolean
) {
  return agentFetch<any>(`/api/v1/agent/threads/${threadId}/pin`, scope, {
    method: "POST",
    body: typeof pinned === "boolean" ? { pinned } : {},
  });
}

/** Theme F.10 — archive (soft, filter-out by default). */
export async function archiveThread(threadId: string, scope: AgentScope) {
  return agentFetch<any>(`/api/v1/agent/threads/${threadId}/archive`, scope, {
    method: "POST",
    body: {},
  });
}

/** Theme F.10 — reverse archive. */
export async function unarchiveThread(threadId: string, scope: AgentScope) {
  return agentFetch<any>(`/api/v1/agent/threads/${threadId}/unarchive`, scope, {
    method: "POST",
    body: {},
  });
}

/** Get thread messages */
export async function getThreadMessages(threadId: string, scope: AgentScope) {
  return agentFetch<{ messages: any[]; total: number }>(
    `/api/v1/agent/threads/${threadId}/messages`,
    scope
  );
}

/** List tools in a scope */
export async function listTools(scope: AgentScope, category?: string) {
  const qs = category ? `?category=${category}` : "";
  return agentFetch<{ tools: any[]; total: number }>(
    `/api/v1/agent/tools${qs}`,
    scope
  );
}

/** Search tools */
export async function searchTools(
  query: string,
  scope: AgentScope,
  sourceEntityId?: string
) {
  const params = new URLSearchParams({ q: query });
  if (sourceEntityId) params.set("entity", sourceEntityId);
  return agentFetch<{ query: string; results: any[]; total: number }>(
    `/api/v1/agent/tools/search?${params.toString()}`,
    scope
  );
}

/** Get tool stats */
export async function getToolStats(scope: AgentScope) {
  return agentFetch<{
    totalDocs: number;
    uniqueTerms: number;
    avgDocLength: number;
    cachedOrgs: number;
  }>("/api/v1/agent/tools/stats", scope);
}

/** List connected entities (formerly listOrgs) */
export async function listEntities(scope: AgentScope) {
  return agentFetch<{ entities: any[] }>("/api/v1/agent/entities", scope);
}

/** Get entity details (formerly getOrg) */
export async function getEntity(entityId: string, scope: AgentScope) {
  return agentFetch<any>(`/api/v1/agent/entities/${entityId}`, scope);
}

/**
 * Get daily cost for the current scope (formerly getOrgCost).
 * The agent endpoint no longer takes an orgId segment — scope is
 * conveyed purely via headers.
 */
export async function getScopeCost(scope: AgentScope, date?: string) {
  const qs = date ? `?date=${date}` : "";
  return agentFetch<{
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }>(`/api/v1/agent/monitoring/cost${qs}`, scope);
}

/**
 * SM.2 — Skill usage breakdown for a single day.
 * Returns empty arrays when no skill events exist in the scope.
 */
export type SkillCostDailyPayload = {
  date: string;
  totalCostCents: number;
  totalCalls: number;
  bySkill: Array<{
    slug: string;
    totalCents: number;
    calls: number;
    inputUnits: number;
    outputUnits: number;
    latencyMsTotal: number;
  }>;
  byTool: Array<{ slug: string; tool: string; calls: number; latencyMsTotal: number }>;
  byAgent: Array<{ agentId: string; agentName: string | null; totalCents: number; calls: number }>;
  byProvider: Array<{ provider: string; totalCents: number; calls: number }>;
  fetchedAt: string;
};

export async function getSkillCostDaily(scope: AgentScope, date?: string) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  return agentFetch<SkillCostDailyPayload>(
    `/api/v1/agent/monitoring/cost/skills/daily${qs}`,
    scope,
  );
}

/** SM.2 — Skill usage breakdown for a date range. */
export type SkillCostRangePayload = {
  from: string;
  to: string;
  totalCostCents: number;
  totalCalls: number;
  perDay: Array<{ date: string; totalCostCents: number; totalCalls: number }>;
  bySkill: SkillCostDailyPayload["bySkill"];
  byTool: SkillCostDailyPayload["byTool"];
  byAgent: SkillCostDailyPayload["byAgent"];
  byProvider: SkillCostDailyPayload["byProvider"];
  fetchedAt: string;
};

export async function getSkillCostRange(scope: AgentScope, from: string, to: string) {
  const params = new URLSearchParams({ from, to });
  return agentFetch<SkillCostRangePayload>(
    `/api/v1/agent/monitoring/cost/skills/range?${params.toString()}`,
    scope,
  );
}

/** List credential providers */
export async function listCredentials(scope: AgentScope) {
  return agentFetch<{ providers: string[] }>("/api/v1/agent/credentials", scope);
}

/** Check if platos-agent is reachable */
export async function isAgentServiceAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_API_URL}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
