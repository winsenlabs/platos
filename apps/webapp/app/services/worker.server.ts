import { ZodWorker } from "@internal/zod-worker";
import { DeliverEmailSchema } from "emails";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  BatchProcessingOptions as RunEngineBatchProcessingOptions,
  RunEngineBatchTriggerService,
} from "~/runEngine/services/batchTrigger.server";
import { rejectLocalScheduleOperation } from "~/v3/externalTriggerBoundary.server";
import { DeliverAlertService } from "~/v3/services/alerts/deliverAlert.server";
import { PerformDeploymentAlertsService } from "~/v3/services/alerts/performDeploymentAlerts.server";
import { PerformTaskRunAlertsService } from "~/v3/services/alerts/performTaskRunAlerts.server";
import { PerformBulkActionService } from "~/v3/services/bulk/performBulkAction.server";
import {
  CancelDevSessionRunsService,
  CancelDevSessionRunsServiceOptions,
} from "~/v3/services/cancelDevSessionRuns.server";
import { TimeoutDeploymentService } from "~/v3/services/timeoutDeployment.server";
import { GraphileMigrationHelperService } from "./db/graphileMigrationHelper.server";
import { sendEmail } from "./email.server";
import { logger } from "./logger.server";

const workerCatalog = {
  // @deprecated, moved to commonWorker.server.ts
  scheduleEmail: DeliverEmailSchema,
  // @deprecated, moved to commonWorker.server.ts
  "v3.timeoutDeployment": z.object({
    deploymentId: z.string(),
    fromStatus: z.string(),
    errorMessage: z.string(),
  }),
  // @deprecated, local scheduled task execution is disabled
  "v3.triggerScheduledTask": z.object({
    instanceId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.performTaskRunAlerts": z.object({
    runId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.deliverAlert": z.object({
    alertId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.performDeploymentAlerts": z.object({
    deploymentId: z.string(),
  }),
  "v3.performBulkAction": z.object({
    bulkActionGroupId: z.string(),
  }),
  "v3.performBulkActionItem": z.object({
    bulkActionItemId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.cancelDevSessionRuns": CancelDevSessionRunsServiceOptions,
  // @deprecated, moved to commonWorker.server.ts
  "runengine.processBatchTaskRun": RunEngineBatchProcessingOptions,
};

let workerQueue: ZodWorker<typeof workerCatalog>;

declare global {
  var __worker__: ZodWorker<typeof workerCatalog>;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (env.NODE_ENV === "production") {
  workerQueue = getWorkerQueue();
} else {
  if (!global.__worker__) {
    global.__worker__ = getWorkerQueue();
  }
  workerQueue = global.__worker__;
}

export async function init() {
  const migrationHelper = new GraphileMigrationHelperService();
  await migrationHelper.call();

  if (env.WORKER_ENABLED === "true") {
    await workerQueue.initialize();
  }
}

function getWorkerQueue() {
  return new ZodWorker({
    name: "workerQueue",
    prisma,
    replica: $replica,
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: env.WORKER_CONCURRENCY,
      pollInterval: env.WORKER_POLL_INTERVAL,
      noPreparedStatements: env.DATABASE_URL !== env.DIRECT_URL,
      schema: env.WORKER_SCHEMA,
      maxPoolSize: env.WORKER_CONCURRENCY + 1,
    },
    logger: logger,
    shutdownTimeoutInMs: env.GRACEFUL_SHUTDOWN_TIMEOUT,
    schema: workerCatalog,
    tasks: {
      // @deprecated, moved to commonWorker.server.ts
      scheduleEmail: {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          await sendEmail(payload);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.timeoutDeployment": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new TimeoutDeploymentService();

          return await service.call(payload.deploymentId, payload.fromStatus, payload.errorMessage);
        },
      },
      // @deprecated, local scheduled task execution is disabled
      "v3.triggerScheduledTask": {
        priority: 0,
        maxAttempts: 3, // total delay of 30 seconds
        handler: async (payload, job) => {
          void payload;
          void job;
          rejectLocalScheduleOperation();
        },
      },
      // @deprecated, moved to alertsWorker.server.ts
      "v3.performTaskRunAlerts": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformTaskRunAlertsService();
          return await service.call(payload.runId);
        },
      },
      // @deprecated, moved to alertsWorker.server.ts
      "v3.deliverAlert": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new DeliverAlertService();

          return await service.call(payload.alertId);
        },
      },
      // @deprecated, moved to alertsWorker.server.ts
      "v3.performDeploymentAlerts": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformDeploymentAlertsService();

          return await service.call(payload.deploymentId);
        },
      },
      // @deprecated, new bulk actions use the new bulk actions worker
      "v3.performBulkAction": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformBulkActionService();

          return await service.call(payload.bulkActionGroupId);
        },
      },
      // @deprecated, new bulk actions use the new bulk actions worker
      "v3.performBulkActionItem": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformBulkActionService();

          await service.performBulkActionItem(payload.bulkActionItemId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.cancelDevSessionRuns": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new CancelDevSessionRunsService();

          return await service.call(payload);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "runengine.processBatchTaskRun": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new RunEngineBatchTriggerService(payload.strategy);

          await service.processBatchTaskRun(payload);
        },
      },
    },
  });
}
export { workerQueue };
