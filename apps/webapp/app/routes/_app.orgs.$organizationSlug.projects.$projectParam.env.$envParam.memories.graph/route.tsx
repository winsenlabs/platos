import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation, numberField, optionalText, requiredText } from "~/services/m4Mutation.server";

function boundedInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const config = {
  surface: "memory-graph" as const,
  title: "Memory graph",
  description: "Entities, shortest paths, and explicit relationships from the clean memory graph.",
  endpoint: (_params: Record<string, string | undefined>, url: URL) => {
    const userId = url.searchParams.get("userId")?.trim();
    const query = new URLSearchParams();
    if (userId) query.set("userId", userId);
    const entityType = url.searchParams.get("entityType")?.trim();
    if (entityType) query.set("entityType", entityType);
    const entityQuery = url.searchParams.get("entityQ")?.trim();
    if (entityQuery) query.set("q", entityQuery);
    query.set("limit", String(boundedInt(url.searchParams.get("entityLimit"), 50, 10, 100)));
    query.set("offset", String(boundedInt(url.searchParams.get("entityOffset"), 0, 0, 100_000)));
    return `/api/v1/memory/graph/entities?${query}`;
  },
  supportingEndpoint: (_params: Record<string, string | undefined>, url: URL) => {
    const userId = url.searchParams.get("userId")?.trim();
    const query = new URLSearchParams();
    if (userId) query.set("userId", userId);
    const entityId = url.searchParams.get("entityId")?.trim();
    if (entityId) return `/api/v1/memory/graph/entities/${encodeURIComponent(entityId)}/relationships${query.size ? `?${query}` : ""}`;
    const from = url.searchParams.get("from")?.trim();
    const to = url.searchParams.get("to")?.trim();
    if (!from || !to) return "/api/health";
    query.set("from", from);
    query.set("to", to);
    const maxHops = url.searchParams.get("maxHops")?.trim();
    if (maxHops) query.set("maxHops", maxHops);
    return `/api/v1/memory/graph/path?${query}`;
  },
  supportingUsesPinnedScope: true,
  secondaryEndpoint: "/api/v1/agent/agents",
  secondaryCollection: { defaultPageSize: 25, maxPageSize: 100, search: true, pageParam: "agentPage", pageSizeParam: "agentPageSize", searchParam: "agentSearch" },
  selectionEndpoint: "/api/v1/agent/agents/:selectedAgentId",
  agentPinQueryParam: "agentId",
  requireAgentPin: true,
  provenance: "Canonical clean database ancestry and platos-agent API",
};

export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }

export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Memory relationship", ({ scope, form }) => {
    const userId = requiredText(form, "userId", "End user");
    const agentId = requiredText(form, "agentId", "Agent");
    return agentRequest("/api/v1/memory/relate", { ...scope, agentId }, {
      method: "POST",
      body: {
        userId,
        fromEntityKey: requiredText(form, "fromEntityKey", "From entity key"),
        toEntityKey: requiredText(form, "toEntityKey", "To entity key"),
        relationshipType: requiredText(form, "relationshipType", "Relationship type"),
        ...(optionalText(form, "weight") ? { weight: numberField(form, "weight", { min: 0, max: 1 }) } : {}),
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
