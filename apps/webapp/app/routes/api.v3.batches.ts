import { json } from "@remix-run/server-runtime";
import { CreateBatchRequestBody } from "@platos/core/v3";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ExternalTriggerHeadersSchema } from "~/v3/externalTriggerBoundary.server";

const { action, loader } = createActionApiRoute(
  {
    headers: ExternalTriggerHeadersSchema,
    body: CreateBatchRequestBody,
    allowJWT: true,
    maxContentLength: 131_072,
    authorization: {
      action: "batchTrigger",
      resource: () => ({ tasks: [] }),
      superScopes: ["write:tasks", "admin"],
    },
    corsStrategy: "all",
  },
  async () =>
    json(
      { error: { code: "EXTERNAL_TRIGGER_REQUIRED" } },
      { status: 409, headers: { "x-should-retry": "false" } }
    )
);

export { action, loader };
