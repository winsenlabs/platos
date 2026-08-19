import type { INestApplicationContext } from "@nestjs/common";
import type Redis from "ioredis";

export interface DisconnectablePrisma {
  $disconnect(): Promise<void>;
}

export interface StdioOwnedResources {
  abortController: AbortController;
  app: Pick<INestApplicationContext, "close">;
  prisma: DisconnectablePrisma;
  redis: Pick<Redis, "quit" | "disconnect" | "status">;
}

/** Release every resource owned by the standalone stdio application context. */
export async function closeStdioOwnedResources(resources: StdioOwnedResources): Promise<void> {
  resources.abortController.abort();
  await Promise.allSettled([resources.app.close()]);
  await Promise.allSettled([resources.prisma.$disconnect(), closeRedis(resources.redis)]);
}

async function closeRedis(
  redis: Pick<Redis, "quit" | "disconnect" | "status">,
): Promise<void> {
  if (redis.status === "end") return;
  try {
    await redis.quit();
  } catch {
    redis.disconnect(false);
  }
}

/** Never let a hung driver prevent an IDE MCP child process from exiting. */
export async function withCleanupDeadline(
  cleanup: Promise<void>,
  timeoutMs: number,
): Promise<"closed" | "timed_out"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  const result = await Promise.race([cleanup.then(() => "closed" as const), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
