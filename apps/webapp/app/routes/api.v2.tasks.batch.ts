import { json } from "@remix-run/server-runtime";
import { BatchTriggerTaskV3RequestBody } from "@platos/core/v3";
import { z } from "zod";
import { env } from "~/env.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ExternalTriggerHeadersSchema } from "~/v3/externalTriggerBoundary.server";

const BatchProcessingStrategy = z.enum(["sequential", "parallel"]);

const { action, loader } = createActionApiRoute(
  {
    headers: ExternalTriggerHeadersSchema.extend({
      "batch-processing-strategy": BatchProcessingStrategy.nullish(),
    }),
    body: BatchTriggerTaskV3RequestBody,
    allowJWT: true,
    maxContentLength: env.BATCH_TASK_PAYLOAD_MAXIMUM_SIZE,
    authorization: {
      action: "batchTrigger",
      resource: (_, __, ___, body) => ({
        tasks: Array.from(new Set(body.items.map((item) => item.task))),
      }),
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
