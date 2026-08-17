import { Logger } from "@platos/core/logger";
import { Worker as RedisWorker } from "@platos/redis-worker";
import { DeliverEmailSchema } from "emails";
import { env } from "~/env.server";
import { sendEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";

function initializeWorker() {
  const worker = new RedisWorker({
    name: "common-worker",
    redisOptions: {
      keyPrefix: "common:worker:",
      host: env.COMMON_WORKER_REDIS_HOST,
      port: env.COMMON_WORKER_REDIS_PORT,
      username: env.COMMON_WORKER_REDIS_USERNAME,
      password: env.COMMON_WORKER_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.COMMON_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    catalog: {
      scheduleEmail: {
        schema: DeliverEmailSchema,
        visibilityTimeoutMs: 60_000,
        retry: { maxAttempts: 3 },
      },
    },
    concurrency: {
      workers: env.COMMON_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.COMMON_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.COMMON_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.COMMON_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.COMMON_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.COMMON_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("CommonWorker", env.COMMON_WORKER_LOG_LEVEL),
    jobs: {
      scheduleEmail: async ({ payload }) => {
        await sendEmail(payload);
      },
    },
  });

  if (env.COMMON_WORKER_ENABLED === "true") {
    logger.debug("Starting common email worker");
    worker.start();
  }

  return worker;
}

export const commonWorker = singleton("commonWorker", initializeWorker);
