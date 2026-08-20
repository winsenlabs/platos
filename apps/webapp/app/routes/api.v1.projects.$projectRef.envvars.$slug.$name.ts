import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { UpdateEnvironmentVariableRequestBody } from "@platos/core/v3";
import { z } from "zod";
import {
  authenticateRequest,
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import {
  authorizeCanonicalEnvironmentService,
  deleteCanonicalEnvironmentVariableById,
  listCanonicalEnvironmentVariables,
  updateCanonicalEnvironmentVariableById,
} from "~/services/platosEnvironmentVariables.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  slug: z.string(),
  name: z.string(),
});

export async function action({ params, request }: ActionFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  const authenticationResult = await authenticateRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.slug,
    branchNameFromRequest(request)
  );

  const authorization = await authorizeCanonicalEnvironmentService({
    environment,
    actorId: `envvars-api:${environment.id}`,
  });
  const variable = (await listCanonicalEnvironmentVariables(authorization)).find(
    (candidate) => candidate.key === parsedParams.data.name
  );

  if (!variable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  switch (request.method.toUpperCase()) {
    case "DELETE": {
      const deleted = await deleteCanonicalEnvironmentVariableById({
        authorization,
        id: variable.id,
      });
      if (deleted) {
        return json({ success: true });
      } else {
        return json({ error: "Environment variable not found" }, { status: 404 });
      }
    }
    case "PUT":
    case "POST": {
      const jsonBody = await request.json();

      const body = UpdateEnvironmentVariableRequestBody.safeParse(jsonBody);

      if (!body.success) {
        return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
      }

      const updated = await updateCanonicalEnvironmentVariableById({
        authorization,
        id: variable.id,
        value: body.data.value,
        lastUpdatedBy: authorization.actorId,
      });
      if (updated) {
        return json({ success: true });
      } else {
        return json({ error: "Environment variable not found" }, { status: 404 });
      }
    }
  }
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  const authenticationResult = await authenticateRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.slug,
    branchNameFromRequest(request)
  );

  const authorization = await authorizeCanonicalEnvironmentService({
    environment,
    actorId: `envvars-api:${environment.id}`,
  });
  const variable = (await listCanonicalEnvironmentVariables(authorization)).find(
    (candidate) => candidate.key === parsedParams.data.name
  );

  if (!variable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  return json({
    name: variable.key,
    value: variable.kind === "PLAIN" ? variable.value ?? "" : "",
    isSecret: variable.kind === "SECRET",
  });
}
