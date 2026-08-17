/**
 * Theme I.9 — Dev-mode mint-token endpoint.
 *
 * POST /orgs/:org/projects/:proj/env/:env/agent-connect/mint-token
 *
 * Returns a 5-minute Platos session token signed with
 * `SESSION_SECRET`. Hard-gated on `PLATOS_TEST_MODE === "true"`
 * so it can never accidentally mint tokens in production.
 */

import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { mintPlatosSessionToken } from "~/services/platosSessionToken.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export async function action({ request, params }: ActionFunctionArgs) {
  if (process.env.PLATOS_TEST_MODE !== "true") {
    return json(
      { error: "disabled", message: "Dev-mode mint-token is only available when PLATOS_TEST_MODE=true." },
      { status: 403 },
    );
  }

  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "not_found" }, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) return json({ error: "not_found" }, { status: 404 });

  const minted = mintPlatosSessionToken(
    {
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      userId,
    },
    /* ttlSeconds */ 300,
  );
  if (!minted) {
    return json(
      { error: "not_configured", message: "SESSION_SECRET is not set on the webapp." },
      { status: 500 },
    );
  }

  return json({ token: minted.token, exp: minted.exp });
}

// Block GETs — explicit 405 rather than Remix's default 404 from a
// loaderless resource route.
export function loader() {
  return json({ error: "method_not_allowed" }, { status: 405 });
}
