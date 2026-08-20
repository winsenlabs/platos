import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { ImportEnvironmentVariablesRequestBody } from "@platos/core/v3";
import { parse } from "dotenv";
import { z } from "zod";
import {
  authenticateRequest,
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import {
  authorizeCanonicalEnvironmentService,
  importCanonicalEnvironmentVariables,
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

  const body = await parseImportBody(request);
  const authorization = await authorizeCanonicalEnvironmentService({
    environment,
    actorId: `envvars-import:${environment.id}`,
  });
  const parentAuthorization = environment.parentEnvironmentId
    ? await authorizeCanonicalEnvironmentService({
        environment: { id: environment.parentEnvironmentId },
        actorId: `envvars-import:${environment.id}`,
      })
    : undefined;
  const result = await importCanonicalEnvironmentVariables({
    authorization,
    override: typeof body.override === "boolean" ? body.override : false,
    variables: body.variables,
    parentAuthorization,
  });

  // Only sync parent variables if this is a branch environment
  if (parentAuthorization && body.parentVariables) {
    const parentResult = await importCanonicalEnvironmentVariables({
      authorization: parentAuthorization,
      override: typeof body.override === "boolean" ? body.override : false,
      variables: body.parentVariables,
    });

    let childFailure = !result.success ? result : undefined;
    let parentFailure = !parentResult.success ? parentResult : undefined;

    if (result.success && parentResult.success) {
      return json({ success: true });
    } else {
      return json(
        {
          error: childFailure?.error || parentFailure?.error || "Unknown error",
          variableErrors: {
            ...(childFailure?.variableErrors ?? {}),
            ...(parentFailure?.variableErrors ?? {}),
          },
        },
        { status: 400 }
      );
    }
  }

  if (result.success) {
    return json({ success: true });
  } else {
    return json({ error: result.error, variableErrors: result.variableErrors }, { status: 400 });
  }
}

async function parseImportBody(request: Request): Promise<ImportEnvironmentVariablesRequestBody> {
  const contentType = request.headers.get("content-type") ?? "application/json";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();

    const file = formData.get("variables");
    const override = formData.get("override") === "true";

    if (file instanceof File) {
      const buffer = await file.arrayBuffer();

      const variables = parse(Buffer.from(buffer));

      return { variables, override };
    } else {
      throw json({ error: "Invalid file" }, { status: 400 });
    }
  } else {
    const rawBody = await request.json();

    const body = ImportEnvironmentVariablesRequestBody.safeParse(rawBody);

    if (!body.success) {
      throw json({ error: "Invalid body" }, { status: 400 });
    }

    return body.data;
  }
}
