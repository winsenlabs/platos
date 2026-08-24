import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentResponse } from "~/services/platosAgent.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!params.organizationSlug || !params.projectParam || !params.envParam) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request, organizationSlug: params.organizationSlug, projectSlug: params.projectParam, environmentSlug: params.envParam });
  const userId = new URL(request.url).searchParams.get("userId")?.trim();
  const agentId = new URL(request.url).searchParams.get("agentId")?.trim();
  if (!userId) throw new Response("End user is required", { status: 400 });
  if (!agentId) throw new Response("Agent is required", { status: 400 });
  const response = await agentResponse(`/api/v1/memory/export?userId=${encodeURIComponent(userId)}`, { ...scope, agentId });
  if (!response.ok) throw new Response("Memory export unavailable", { status: response.status });
  return new Response(response.body, {
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Content-Disposition": response.headers.get("Content-Disposition") ?? 'attachment; filename="platos-memory.json"',
    },
  });
}
