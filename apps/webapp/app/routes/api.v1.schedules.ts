import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";

const SearchParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().optional(),
});

export async function action(_args: ActionFunctionArgs) {
  return json({ error: { code: "EXTERNAL_TRIGGER_REQUIRED" } }, { status: 409 });
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const rawSearchParams = new URL(request.url).searchParams;
  const params = SearchParamsSchema.safeParse(Object.fromEntries(rawSearchParams.entries()));

  if (!params.success) {
    return json(
      { error: "Invalid request parameters", issues: params.error.issues },
      { status: 400 }
    );
  }

  const presenter = new ScheduleListPresenter();

  const result = await presenter.call({
    projectId: authenticationResult.environment.projectId,
    environmentId: authenticationResult.environment.id,
    page: params.data.page ?? 1,
    pageSize: params.data.perPage,
  });

  return {
    data: result.schedules.map((schedule) => ({
      id: schedule.friendlyId,
      type: schedule.type,
      task: schedule.taskIdentifier,
      generator: {
        type: "CRON",
        expression: schedule.cron,
        description: schedule.cronDescription,
      },
      timezone: schedule.timezone,
      deduplicationKey: schedule.userProvidedDeduplicationKey
        ? schedule.deduplicationKey
        : undefined,
      externalId: schedule.externalId,
      active: schedule.active,
      nextRun: schedule.nextRun,
      environments: schedule.environments,
    })),
    pagination: {
      currentPage: result.currentPage,
      totalPages: result.totalPages,
      count: result.totalCount,
    },
  };
}
