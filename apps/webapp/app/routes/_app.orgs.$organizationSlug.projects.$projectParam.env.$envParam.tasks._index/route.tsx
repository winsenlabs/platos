/**
 * PIFSP-2 — `/tasks` route.
 *
 * The trigger.dev Tasks landing was previously at the env root (`_index`).
 * Now that `_index` hosts Plato Central, this route provides a 302 shim so
 * any existing bookmarks / sidebar links to `/tasks` still work.
 * Redirects to the Runs view which shows the execution history.
 */
import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { requireUserId } from "~/services/session.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });
  return redirect(
    `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/runs`
  );
}
