import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, booleanField, enumField, jsonObject, m4Mutation, optionalText, requiredText } from "~/services/m4Mutation.server";

const config = {
  surface: "memories" as const,
  title: "Memory",
  description: "Environment-scoped memory with explicit cluster widening.",
  endpoint: (_params: Record<string, string | undefined>, url: URL) => {
    const query = url.searchParams.get("q")?.trim();
    const kind = url.searchParams.get("kind")?.trim();
    const userId = url.searchParams.get("userId")?.trim();
    const search = new URLSearchParams();
    if (userId) search.set("userId", userId);
    if (kind) search.set("kind", kind);
    if (!query) return `/api/v1/memory${search.size ? `?${search}` : ""}`;
    search.set("q", query);
    return `/api/v1/memory/search?${search}`;
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
  return m4Mutation(args, "Memory mutation", ({ scope, form }) => {
    const intent = optionalText(form, "intent") ?? "memory-create";
    const userId = requiredText(form, "userId", "End user");
    const agentId = requiredText(form, "agentId", "Agent");
    const pinnedScope = { ...scope, agentId };
    if (intent === "memory-delete") {
      return agentRequest(`/api/v1/memory/${encodeURIComponent(requiredText(form, "id", "Memory ID"))}?userId=${encodeURIComponent(userId)}`, pinnedScope, { method: "DELETE" });
    }
    if (intent === "memory-toggle") {
      return agentRequest(`/api/v1/memory/${encodeURIComponent(requiredText(form, "id", "Memory ID"))}`, pinnedScope, { method: "POST", body: { userId, agentVisible: booleanField(form, "agentVisible") } });
    }
    if (intent === "memory-extract") {
      return agentRequest("/api/v1/memory/extract", pinnedScope, { method: "POST", body: { userId, threadId: requiredText(form, "threadId", "Thread ID") } });
    }
    if (intent === "memory-import") {
      return agentRequest("/api/v1/memory/import", pinnedScope, { method: "POST", body: { userId, mode: enumField(form, "mode", ["merge", "replace"] as const, "merge"), bundle: jsonObject(form, "bundle") } });
    }
    return agentRequest("/api/v1/memory", pinnedScope, {
      method: "POST",
      body: {
        userId,
        content: requiredText(form, "content", "Memory content"),
        kind: enumField(form, "kind", ["fact", "preference", "event", "relationship"] as const, "fact"),
        visibility: enumField(form, "visibility", ["private", "agent", "cluster"] as const, "private"),
        source: "manual",
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
