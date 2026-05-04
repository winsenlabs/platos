/**
 * GET /api/v1/agent/evals — Theme J.5 query API (public).
 *
 * Lists PlatosAgentEval rows in the caller's scope. Filter by agentId,
 * agentVersionId, criterionId, threadId, or runId. Default window is 30
 * days; caller can widen via `sinceDays` up to 365. Pagination via
 * `limit` (max 200) + `offset`.
 *
 * Proxies to the agent service `/api/v1/agent/evals` endpoint — the
 * agent enforces scope via ScopeGuard on the request headers, so
 * cross-scope reads are structurally blocked.
 *
 * Accepts scope as EITHER (organizationId, projectId, environmentId)
 * query params (raw IDs) OR (organizationSlug, projectSlug, envSlug)
 * which the webapp resolves before forwarding.
 */
import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";
import { resolveAndVerifyScope, scopeErrorStatus } from "~/services/platos/scopeVerify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);

  // EOBD.6 — every path (raw-id OR slug) now goes through access-
  // checked resolution. The prior raw-id path forwarded caller-supplied
  // org/project/env IDs verbatim with no authz check, letting any
  // authenticated user read another org's eval data.
  const verified = await resolveAndVerifyScope(
    {
      organizationId: url.searchParams.get("organizationId"),
      projectId: url.searchParams.get("projectId"),
      environmentId: url.searchParams.get("environmentId"),
      organizationSlug: url.searchParams.get("organizationSlug"),
      projectSlug: url.searchParams.get("projectSlug"),
      envSlug: url.searchParams.get("envSlug"),
    },
    userId,
  );
  if (!verified.ok) {
    return json({ error: verified.error.message }, { status: scopeErrorStatus(verified.error) });
  }
  const { organizationId, projectId, environmentId } = verified.scope;

  // Forward any supported filter verbatim.
  const forward = new URLSearchParams();
  for (const key of [
    "agentId",
    "agentVersionId",
    "criterionId",
    "threadId",
    "runId",
    "sinceDays",
    "limit",
    "offset",
  ]) {
    const v = url.searchParams.get(key);
    if (v != null && v.length > 0) forward.set(key, v);
  }

  const AGENT_API_URL =
    process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const upstream = await fetch(
      `${AGENT_API_URL}/api/v1/agent/evals?${forward.toString()}`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Organization-Id": organizationId,
          "X-Platos-Project-Id": projectId,
          "X-Platos-Environment-Id": environmentId,
          "X-Platos-User-Id": userId,
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await upstream.json().catch(() => ({}));
    return json(body, { status: upstream.status });
  } catch (err: any) {
    return json(
      { error: err?.message || "Upstream eval service unavailable" },
      { status: 502 },
    );
  }
}
