import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { resolveCanonicalEnvironmentVariablesForRuntime } from "~/services/platosEnvironmentVariables.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { projectRef } = parsedParams.data;

  if (authenticationResult.environment.project.externalRef !== projectRef) {
    return json({ error: "Project not found" }, { status: 404 });
  }
  const variables = await resolveCanonicalEnvironmentVariablesForRuntime({
    environment: authenticationResult.environment,
    parentEnvironment: authenticationResult.environment.parentEnvironmentId
      ? { id: authenticationResult.environment.parentEnvironmentId }
      : undefined,
    actorId: `envvars-runtime:${authenticationResult.environment.id}`,
  });

  return json({
    variables: variables.reduce((acc: Record<string, string>, variable) => {
      acc[variable.key] = variable.value;
      return acc;
    }, {}),
  });
}
