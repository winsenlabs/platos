import { json, type ActionFunctionArgs } from "@remix-run/node";
import { publicAgentResponse } from "~/services/platosAgent.server";

const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const agentId = String(form.get("agentId") ?? "");
  const environmentId = String(form.get("environmentId") ?? "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId) || !ENVIRONMENT_ID.test(environmentId)) {
    return json({ error: "Not found" }, { status: 404 });
  }
  try {
    const response = await publicAgentResponse("/api/v1/public/guest-token", {
      body: { agentId, environmentId },
      forwardedFor: request.headers.get("X-Forwarded-For") ?? "unknown",
    });
    if (!response.ok) {
      return json({ error: "Guest session unavailable" }, { status: response.status });
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ error: "Guest session unavailable" }, { status: 502 });
    }
    const record = payload as Record<string, unknown>;
    if (
      typeof record.token !== "string" || !record.token ||
      typeof record.guestId !== "string" ||
      typeof record.expiresAt !== "number" ||
      typeof record.agentId !== "string" ||
      typeof record.environmentId !== "string"
    ) {
      return json({ error: "Guest session unavailable" }, { status: 502 });
    }
    return json({
      token: record.token,
      guestId: record.guestId,
      expiresAt: record.expiresAt,
      agentId: record.agentId,
      environmentId: record.environmentId,
    });
  } catch {
    return json({ error: "Guest session unavailable" }, { status: 503 });
  }
}
