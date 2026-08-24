import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation, numberField, optionalText, requiredText } from "~/services/m4Mutation.server";

const config = {
  surface: "memory-graph" as const,
  title: "Memory graph",
  description: "Entities, shortest paths, and explicit relationships from the clean memory graph.",
  endpoint: (_params: Record<string, string | undefined>, url: URL) => {
    const userId = url.searchParams.get("userId")?.trim();
    const query = new URLSearchParams();
    if (userId) query.set("userId", userId);
    const entityId = url.searchParams.get("entityId")?.trim();
    if (entityId) return `/api/v1/memory/graph/entities/${encodeURIComponent(entityId)}/relationships${query.size ? `?${query}` : ""}`;
    const from = url.searchParams.get("from")?.trim();
    const to = url.searchParams.get("to")?.trim();
    if (!from || !to) return `/api/v1/memory/graph/entities${query.size ? `?${query}` : ""}`;
    query.set("from", from);
    query.set("to", to);
    const maxHops = url.searchParams.get("maxHops")?.trim();
    if (maxHops) query.set("maxHops", maxHops);
    return `/api/v1/memory/graph/path?${query}`;
  },
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
