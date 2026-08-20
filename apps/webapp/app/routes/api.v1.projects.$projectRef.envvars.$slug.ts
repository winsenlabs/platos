import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { CreateEnvironmentVariableRequestBody } from "@platos/core/v3";
import { z } from "zod";
import {
  authenticateRequest,
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import {
  authorizeCanonicalEnvironmentService,
  listCanonicalEnvironmentVariables,
  setCanonicalEnvironmentVariable,
} from "~/services/platosEnvironmentVariables.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  slug: z.string(),
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

  const jsonBody = await request.json();

  const body = CreateEnvironmentVariableRequestBody.safeParse(jsonBody);

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const authorization = await authorizeCanonicalEnvironmentService({
    environment,
    actorId: `envvars-api:${environment.id}`,
  });
  try {
    await setCanonicalEnvironmentVariable({
      authorization,
      key: body.data.name,
      value: body.data.value,
      secret: false,
      lastUpdatedBy: authorization.actorId,
    });
    return json({ success: true });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Failed to create environment variable" },
      { status: 400 }
    );
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
  const variables = await listCanonicalEnvironmentVariables(authorization);

  return json(
    variables.map((variable) => ({
      name: variable.key,
      value: variable.kind === "PLAIN" ? variable.value ?? "" : "",
      isSecret: variable.kind === "SECRET",
    }))
  );
}
