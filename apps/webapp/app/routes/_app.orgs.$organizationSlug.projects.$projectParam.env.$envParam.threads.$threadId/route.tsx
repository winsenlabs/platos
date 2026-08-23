import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentPanel } from "~/services/platosAgent.server";

const config = {
  surface: "thread" as const,
  title: "Thread diagnostic",
  description: "Ground-truth Turn usage, cache classes, token composition, Tool Call errors and compaction boundary.",
  provenance: "Merged Thread, Message, Turn ledger, trace spans, and Tool audit from canonical clean stores",
};

export async function loader(args: LoaderFunctionArgs) {
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
  const id = encodeURIComponent(threadId);
  const thread = await agentPanel(`/api/v1/agent/threads/${id}?allUsers=true`, scope);
  if (!thread.ok) {
    if (thread.error.status === 404) {
      throw new Response(thread.error.message, { status: 404, statusText: "Not Found" });
    }
    return json({ ...config, panel: thread });
  }
  const [messages, trace, toolAudit] = await Promise.all([
    agentPanel(`/api/v1/agent/threads/${id}/messages?limit=100&allUsers=true`, scope),
    agentPanel(`/api/v1/agent/monitoring/trace/${id}`, scope),
    agentPanel(`/api/v1/agent/monitoring/tool-audit?threadId=${id}`, scope),
  ]);
  return json({
    ...config,
    panel: {
      ok: true as const,
      data: {
        thread: thread.data,
        messages: messages.ok ? messages.data : null,
        trace: trace.ok ? trace.data : null,
        toolAudit: toolAudit.ok ? toolAudit.data : null,
        unavailable: [messages, trace, toolAudit]
          .filter((panel) => !panel.ok)
          .map((panel) => panel.ok ? null : panel.error),
      },
    },
  });
}

export default function ThreadRoute() {
  return <M4Surface data={useLoaderData<typeof loader>()} />;
}
