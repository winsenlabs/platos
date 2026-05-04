/**
 * Resource route: proxies agent API requests from the Remix frontend
 * to the platos-agent NestJS service (port 3100).
 *
 * The Remix app handles auth (session cookies), then forwards requests
 * to the agent service with the appropriate scope headers.
 *
 * Callers must pass scope IDs as query params, since this route is not
 * bound to a scoped URL segment:
 *   /resources/agent?path=/api/v1/agent/threads
 *     &organizationId=org_...&projectId=proj_...&environmentId=env_...
 *
 * The route then forwards those as the X-Platos-* headers expected by
 * the agent service's ScopeGuard.
 */
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";
import {
  resolveAndVerifyScope,
  scopeErrorStatus,
} from "~/services/platos/scopeVerify.server";

const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

/**
 * EOBD-W3-followup — `resources.agent.ts` was the worst cross-tenant
 * IDOR in the webapp: a generic proxy that forwards RAW scope IDs to
 * anything under `/api/v1/agent/*`. Same class as EOBD.6/7/8 but
 * broader blast radius — one route proxied every agent endpoint.
 * Now routes every scope resolution through `resolveAndVerifyScope`,
 * which checks OrgMember + project-org ownership + env-project
 * ownership before returning the tuple.
 */
async function resolveScope(url: URL, userId: string): Promise<
  | {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
    }
  | { error: string; status: number }
> {
  const verified = await resolveAndVerifyScope(
    {
      organizationId: url.searchParams.get("organizationId"),
      projectId: url.searchParams.get("projectId"),
      environmentId: url.searchParams.get("environmentId"),
      organizationSlug: url.searchParams.get("organizationSlug"),
      projectSlug:
        url.searchParams.get("projectSlug") ??
        url.searchParams.get("projectParam"),
      envSlug:
        url.searchParams.get("envSlug") ?? url.searchParams.get("envParam"),
    },
    userId,
  );
  if (!verified.ok) {
    return { error: verified.error.message, status: scopeErrorStatus(verified.error) };
  }
  return { ...verified.scope, userId };
}

async function proxyToAgent(
  request: Request,
  path: string,
  scope: { organizationId: string; projectId: string; environmentId: string; userId: string },
  methodOverride?: string,
) {
  const url = `${AGENT_API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };

  // LAUNCH-9 follow-up — Remix forms can only natively submit GET/POST,
  // so callers wanting DELETE/PATCH route through here with `_method` as
  // a query param. The browser sends `POST /resources/agent?_method=DELETE`
  // and the proxy retargets to the agent as a real DELETE. Without this
  // the agent's `@Delete()` handler never matches and the row never
  // deletes (LAUNCH-5 drill-down delete bug).
  const upstreamMethod = (methodOverride || request.method).toUpperCase();

  const init: RequestInit = {
    method: upstreamMethod,
    headers,
  };

  if (upstreamMethod !== "GET" && upstreamMethod !== "HEAD" && upstreamMethod !== "DELETE") {
    // Don't forward the request body for synthesized DELETE — the body
    // carried the `_method` flag, not real payload.
    init.body = await request.text();
  }

  const response = await fetch(url, init);
  // Some endpoints return empty bodies (204 No Content); handle gracefully.
  const text = await response.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
  return json(data, { status: response.status });
}

// GET /resources/agent?path=/api/v1/agent/threads&organizationId=...&projectId=...&environmentId=...
export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) return json({ error: "Missing path parameter" }, { status: 400 });
  const scope = await resolveScope(url, userId);
  if ("error" in scope) return json({ error: scope.error }, { status: scope.status });
  return proxyToAgent(request, path, scope);
}

// POST/PATCH/DELETE /resources/agent
//
// Remix `<form method="...">` only accepts "get" / "post"; to call a
// real DELETE / PATCH on the agent service via this proxy, callers
// pass the intended method as a `_method` query param:
//   submit({}, { method: "post", action: "/resources/agent?path=...&_method=DELETE" })
export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) return json({ error: "Missing path parameter" }, { status: 400 });
  const scope = await resolveScope(url, userId);
  if ("error" in scope) return json({ error: scope.error }, { status: scope.status });
  const methodOverride = url.searchParams.get("_method") ?? undefined;
  return proxyToAgent(request, path, scope, methodOverride);
}
