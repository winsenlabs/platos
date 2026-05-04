/**
 * Backwards-compat shim (PPR-69).
 *
 * The `/agent-orgs` routes were renamed to `/agent-entities` — this
 * shim 307-redirects the old URL to the new one for one release so any
 * bookmarked links or external docs keep working. Delete after the
 * next release; the SideMenu + every `pathBuilder` caller already
 * points at the new path.
 */

import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const url = new URL(request.url);
  const target = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/agent-entities/${url.search}`;
  // 307 preserves the method + body — list loader is a GET so this is
  // functionally equivalent to a 301/302, but keeps strictness.
  return redirect(target, { status: 307 });
}

export default function RedirectPlaceholder() {
  return null;
}
