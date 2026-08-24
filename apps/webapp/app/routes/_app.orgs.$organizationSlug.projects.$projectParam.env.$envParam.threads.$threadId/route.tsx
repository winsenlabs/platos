import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { parseCollectionQuery, withCollectionQuery } from "~/services/pagination.server";
import { agentPanel, agentRequest, PlatosAgentApiError } from "~/services/platosAgent.server";

const collection = { defaultPageSize: 25, maxPageSize: 100 } as const;
const artifactCollection = {
  defaultPageSize: 25,
  maxPageSize: 100,
  pageParam: "artifactPage",
  pageSizeParam: "artifactPageSize",
} as const;
const config = {
  surface: "thread" as const,
  title: "Thread diagnostic",
  description: "Ground-truth Turn usage, cache classes, token composition, Tool Call errors and compaction boundary.",
  provenance: "Merged Thread, Message, Turn ledger, trace spans, Tool audit, and Artifacts from canonical clean stores",
};

async function scoped(args: LoaderFunctionArgs | ActionFunctionArgs) {
  const { organizationSlug, projectParam, envParam, threadId } = args.params;
  if (!organizationSlug || !projectParam || !envParam || !threadId) {
    throw new Response("Invalid scope", { status: 400 });
  }
  const { scope } = await requireEnvironmentScope({
    request: args.request,
    organizationSlug,
    projectSlug: projectParam,
    environmentSlug: envParam,
  });
  return { scope, threadId };
}

export async function loader(args: LoaderFunctionArgs) {
  const { scope, threadId } = await scoped(args);
  const id = encodeURIComponent(threadId);
  const thread = await agentPanel(`/api/v1/agent/threads/${id}`, scope);
  if (!thread.ok) {
    if (thread.error.status === 404) {
      throw new Response(thread.error.message, { status: 404, statusText: "Not Found" });
    }
    return json({ ...config, panel: thread });
  }

  const url = new URL(args.request.url);
  const query = parseCollectionQuery(url, collection);
  const artifactQuery = parseCollectionQuery(url, artifactCollection);
  const messagePath = withCollectionQuery(`/api/v1/agent/threads/${id}/messages`, query, collection);
  const artifactPath = withCollectionQuery(`/api/v1/agent/threads/${id}/artifacts`, artifactQuery, artifactCollection);
  const [messages, artifacts, trace, toolAudit] = await Promise.all([
    agentPanel(messagePath, scope),
    agentPanel(artifactPath, scope),
    agentPanel(`/api/v1/agent/monitoring/trace/${id}`, scope),
    agentPanel(`/api/v1/agent/monitoring/tool-audit?threadId=${id}`, scope),
  ]);
  return json({
    ...config,
    collection: query,
    artifactCollection: artifactQuery,
    panel: {
      ok: true as const,
      data: {
        thread: thread.data,
        messages: messages.ok ? messages.data : null,
        artifacts: artifacts.ok ? artifacts.data : null,
        trace: trace.ok ? trace.data : null,
        toolAudit: toolAudit.ok ? toolAudit.data : null,
        unavailable: [messages, artifacts, trace, toolAudit]
          .filter((panel) => !panel.ok)
          .map((panel) => panel.ok ? null : panel.error),
      },
    },
  });
}

export async function action(args: ActionFunctionArgs) {
  const { scope, threadId } = await scoped(args);
  const form = await args.request.formData();
  if (form.get("intent") !== "fork") {
    return json({ ok: false, error: "Unsupported Thread action" }, { status: 400 });
  }
  const upToMessageId = String(form.get("upToMessageId") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(upToMessageId) || title.length > 200) {
    return json({ ok: false, error: "Select a valid fork boundary and a title of at most 200 characters" }, { status: 400 });
  }

  try {
    const child = await agentRequest<Record<string, unknown>>(
      `/api/v1/agent/threads/${encodeURIComponent(threadId)}/fork`,
      scope,
      { method: "POST", body: { upToMessageId, ...(title ? { title } : {}) } },
    );
    const childId = typeof child.id === "string" ? child.id : "";
    if (!childId) throw new PlatosAgentApiError(502, "THREAD_READ_BACK_FAILED", "Forked Thread could not be read back");
    const persisted = await agentRequest<Record<string, unknown>>(`/api/v1/agent/threads/${encodeURIComponent(childId)}`, scope);
    if (persisted.id !== childId || persisted.parentThreadId !== threadId) {
      throw new PlatosAgentApiError(502, "THREAD_READ_BACK_FAILED", "Forked Thread could not be read back");
    }
    const current = new URL(args.request.url);
    current.pathname = current.pathname.replace(/\/[^/]+\/?$/, `/${encodeURIComponent(childId)}`);
    current.search = "";
    return redirect(`${current.pathname}${current.search}`);
  } catch (error) {
    if (error instanceof PlatosAgentApiError) {
      return json({ ok: false, error: error.message, code: error.code }, { status: error.status });
    }
    return json({ ok: false, error: "Thread fork is unavailable" }, { status: 503 });
  }
}

export default function ThreadRoute() {
  return <M4Surface data={useLoaderData<typeof loader>()} />;
}
