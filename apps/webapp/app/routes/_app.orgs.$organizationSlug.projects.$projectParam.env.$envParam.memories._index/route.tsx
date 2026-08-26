import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  MEMORY_ARCHIVE_STATES,
  MEMORY_KINDS,
  MEMORY_SOURCES,
  MEMORY_VISIBILITIES,
  type MemoryKind,
} from "@platos/tenancy-database";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, booleanField, enumField, jsonObject, m4Mutation, optionalText, requiredText, stringList } from "~/services/m4Mutation.server";

function boundedInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function memoryMetadata(form: FormData, kind: MemoryKind) {
  const metadata = jsonObject(form, "metadata");
  const assign = (key: string, value: unknown) => {
    if (value !== undefined && (!(Array.isArray(value)) || value.length)) metadata[key] = value;
  };
  if (kind === "fact") {
    assign("subject", optionalText(form, "subject"));
    assign("topic", optionalText(form, "topic"));
  } else if (kind === "preference") {
    assign("over", stringList(form, "over"));
    assign("ordering", optionalText(form, "ordering"));
  } else if (kind === "event") {
    assign("at", optionalText(form, "at"));
    assign("location", optionalText(form, "location"));
    assign("participants", stringList(form, "participants"));
  } else if (kind === "relationship") {
    metadata.from = requiredText(form, "from", "Relationship from");
    metadata.to = requiredText(form, "to", "Relationship to");
    metadata.type = requiredText(form, "type", "Relationship type");
  } else {
    metadata.profileKey = requiredText(form, "profileKey", "Profile key");
  }
  return metadata;
}

function memoryPayload(form: FormData) {
  const kind = enumField(form, "kind", MEMORY_KINDS, "fact");
  return {
    content: requiredText(form, "content", "Memory content"),
    kind,
    metadata: memoryMetadata(form, kind),
    visibility: enumField(form, "visibility", MEMORY_VISIBILITIES, "private"),
  };
}

const config = {
  surface: "memories" as const,
  title: "Memory",
  description: "Environment-scoped memory with explicit cluster widening.",
  endpoint: (_params: Record<string, string | undefined>, url: URL) => {
    const query = url.searchParams.get("q")?.trim();
    const userId = url.searchParams.get("userId")?.trim();
    const search = new URLSearchParams();
    if (userId) search.set("userId", userId);
    const kind = url.searchParams.get("kind")?.trim();
    if (kind && MEMORY_KINDS.includes(kind as MemoryKind)) search.set("kind", kind);
    const source = url.searchParams.get("source")?.trim();
    if (source && MEMORY_SOURCES.includes(source as (typeof MEMORY_SOURCES)[number])) search.set("source", source);
    const archiveState = url.searchParams.get("archiveState")?.trim();
    if (archiveState && MEMORY_ARCHIVE_STATES.includes(archiveState as (typeof MEMORY_ARCHIVE_STATES)[number])) search.set("archiveState", archiveState);
    search.set("limit", String(boundedInt(url.searchParams.get("limit"), 50, 10, 100)));
    if (!query) search.set("offset", String(boundedInt(url.searchParams.get("offset"), 0, 0, 100_000)));
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
    if (intent === "memory-archive" || intent === "memory-restore") {
      const id = encodeURIComponent(requiredText(form, "id", "Memory ID"));
      const lifecycle = intent === "memory-archive" ? "archive" : "restore";
      return agentRequest(`/api/v1/memory/${id}/${lifecycle}`, pinnedScope, { method: "POST", body: { userId } });
    }
    if (intent === "memory-update") {
      return agentRequest(`/api/v1/memory/${encodeURIComponent(requiredText(form, "id", "Memory ID"))}`, pinnedScope, { method: "POST", body: { userId, ...memoryPayload(form) } });
    }
    if (intent === "memory-visibility") {
      return agentRequest(`/api/v1/memory/${encodeURIComponent(requiredText(form, "id", "Memory ID"))}`, pinnedScope, { method: "POST", body: { userId, visibility: enumField(form, "visibility", MEMORY_VISIBILITIES) } });
    }
    if (intent === "memory-extract") {
      return agentRequest("/api/v1/memory/extract", pinnedScope, { method: "POST", body: { userId, threadId: requiredText(form, "threadId", "Thread ID") } });
    }
    if (intent === "memory-import") {
      const mode = enumField(form, "mode", ["merge", "replace"] as const, "merge");
      const confirmReplace = mode === "replace" && booleanField(form, "confirmReplace");
      if (mode === "replace" && !confirmReplace) {
        throw new Error("Replace import requires explicit destructive confirmation");
      }
      return agentRequest("/api/v1/memory/import", pinnedScope, { method: "POST", body: { userId, mode, confirmReplace, bundle: jsonObject(form, "bundle") } });
    }
    return agentRequest("/api/v1/memory", pinnedScope, {
      method: "POST",
      body: {
        userId,
        ...memoryPayload(form),
        source: "manual",
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
