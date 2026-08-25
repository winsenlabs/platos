import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { sessionAgentResponse } from "~/services/platosAgent.server";
import {
  publicGuestSessionToken,
  sameOriginMutation,
} from "~/services/publicGuestSession.server";

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function proxyRating(request: Request, agentId: string, environmentId: string, messageId: string) {
  if (!SAFE_ID.test(agentId) || !ENVIRONMENT_ID.test(environmentId) || !SAFE_ID.test(messageId)) {
    return json({ error: "Not found" }, { status: 404 });
  }
  const sessionToken = await publicGuestSessionToken(request, agentId, environmentId);
  if (!sessionToken) return json({ error: "Guest session required" }, { status: 401 });

  const method = request.method.toUpperCase();
  let body: { rating: 1 | -1 } | undefined;
  if (method === "POST") {
    if (!sameOriginMutation(request)) {
      return json({ error: "Same-origin JSON request required" }, { status: 403 });
    }
    const payload: unknown = await request.json().catch(() => null);
    const rating =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).rating
        : null;
    if (rating !== 1 && rating !== -1) {
      return json({ error: "rating must be 1 or -1" }, { status: 400 });
    }
    body = { rating };
  } else if (method === "DELETE") {
    if (!sameOriginMutation(request)) {
      return json({ error: "Same-origin JSON request required" }, { status: 403 });
    }
  } else if (method !== "GET") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const upstream = await sessionAgentResponse(
      `/api/v1/agent/messages/${encodeURIComponent(messageId)}/rating`,
      sessionToken,
      { method: method as "GET" | "POST" | "DELETE", body, signal: request.signal },
    );
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return json({ error: "Rating request failed" }, { status: upstream.status || 502 });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ error: "Rating request failed" }, { status: 502 });
    }
    return json(payload, { status: upstream.status });
  } catch {
    return json({ error: "Rating request failed" }, { status: 503 });
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return proxyRating(
    request,
    params.agentId ?? "",
    new URL(request.url).searchParams.get("environmentId") ?? "",
    new URL(request.url).searchParams.get("messageId") ?? "",
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const agentId = params.agentId ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) {
    return json({ error: "Not found" }, { status: 404 });
  }
  const requestUrl = new URL(request.url);
  const environmentId = requestUrl.searchParams.get("environmentId") ?? "";
  if (!ENVIRONMENT_ID.test(environmentId)) {
    return json({ error: "Not found" }, { status: 404 });
  }
  const ratingMessageId = requestUrl.searchParams.get("messageId") ?? "";
  if (ratingMessageId || request.method.toUpperCase() === "DELETE") {
    return proxyRating(request, agentId, environmentId, ratingMessageId);
  }
  if (!sameOriginMutation(request)) {
    return json({ error: "Same-origin JSON request required" }, { status: 403 });
  }
  const sessionToken = await publicGuestSessionToken(request, agentId, environmentId);
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
  try {
    const upstream = await sessionAgentResponse(
      `/api/v1/agent/agents/${encodeURIComponent(agentId)}/chat/stream?${search}`,
      sessionToken,
      { signal: request.signal },
    );
    if (!upstream.ok || !upstream.body) {
      return json({ error: "Streaming failed" }, { status: upstream.status || 502 });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return json({ error: "Streaming failed" }, { status: 503 });
  }
}
