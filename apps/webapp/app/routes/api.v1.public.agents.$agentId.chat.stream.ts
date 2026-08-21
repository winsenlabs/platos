import { json, type ActionFunctionArgs } from "@remix-run/node";
import { sessionAgentResponse } from "~/services/platosAgent.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const agentId = params.agentId ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) {
    return json({ error: "Not found" }, { status: 404 });
  }
  const sessionToken = request.headers.get("X-Platos-Session-Token") ?? "";
  if (!sessionToken || sessionToken.length > 8_192) {
    return json({ error: "Guest session required" }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const message =
    body && typeof body === "object" && !Array.isArray(body)
      ? String((body as Record<string, unknown>).message ?? "").trim()
      : "";
  if (!message || message.length > 20_000) {
    return json({ error: "Message is required and must be at most 20,000 characters" }, { status: 400 });
  }

  const search = new URLSearchParams({ message });
  const upstream = await sessionAgentResponse(
    `/api/v1/agent/agents/${encodeURIComponent(agentId)}/chat/stream?${search}`,
    sessionToken,
    request.signal,
  );
  if (!upstream.ok || !upstream.body) {
    return json(
      { error: await upstream.text().catch(() => "Streaming failed") },
      { status: upstream.status || 502 },
    );
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
