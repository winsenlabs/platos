/**
 * Backwards-compat shim (PPR-69).
 *
 * Redirects `/agent-orgs/:orgId` → `/agent-entities/:entityId` with
 * the same trailing id. Delete after the next release.
 */

import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

function targetUrl(request: Request, params: Record<string, unknown>): string {
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const orgId = (params as { orgId?: string }).orgId ?? "";
  const url = new URL(request.url);
  return `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/agent-entities/${orgId}${url.search}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return redirect(targetUrl(request, params), { status: 307 });
}

export async function action({ request, params }: ActionFunctionArgs) {
  return redirect(targetUrl(request, params), { status: 307 });
}

export default function RedirectPlaceholder() {
  return null;
}
