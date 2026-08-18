import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";

const ParamsSchema = z.object({
  scheduleId: z.string(),
});

export async function action(_args: ActionFunctionArgs) {
  return json({ error: { code: "EXTERNAL_TRIGGER_REQUIRED" } }, { status: 409 });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json(
      { error: "Invalid request parameters", issues: parsedParams.error.issues },
      { status: 400 }
    );
  }

  const presenter = new ViewSchedulePresenter();

  const result = await presenter.call({
    projectId: authenticationResult.environment.projectId,
    friendlyId: parsedParams.data.scheduleId,
    environmentId: authenticationResult.environment.id,
  });

  if (!result) {
    return json({ error: "Schedule not found" }, { status: 404 });
  }

  return json(presenter.toJSONResponse(result), { status: 200 });
}
