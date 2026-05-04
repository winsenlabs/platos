/**
 * Backwards-compat shim (PPR-69).
 *
 * Redirects `/agent-orgs/new` → `/agent-entities/new`. Delete after
 * the next release. See the sibling `_index` shim for rationale.
 */

import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

function targetUrl(request: Request, params: Record<string, unknown>): string {
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const url = new URL(request.url);
  return `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/agent-entities/new${url.search}`;
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
