import { Global, Module, type Provider } from "@nestjs/common";
import Redis from "ioredis";
import { env } from "./env";

export const REDIS_TOKEN = "REDIS";

/**
 * Redis provider — creates an ioredis client connected to the shared Redis.
 * Uses the platos: key prefix to namespace all Platos agent data.
 */
const redisProvider: Provider = {
  provide: REDIS_TOKEN,
  useFactory: (): Redis => {
    const url = env.REDIS_URL || "redis://localhost:6379";
    const parsed = new URL(url);
    const client = new Redis({
      host: parsed.hostname,
      port: parseInt(parsed.port || "6379"),
      password: parsed.password || undefined,
      keyPrefix: "platos:",
      retryStrategy: (times: number) => Math.min(times * 50, 1000),
      maxRetriesPerRequest: 20,
    });

    client.on("connect", () => console.log("[Platos] Redis connected"));
    client.on("error", (err) => console.error("[Platos Redis]", err.message));

    return client;
  },
};

@Global()
@Module({
  providers: [redisProvider],
  exports: [REDIS_TOKEN],
})
export class RedisModule {}
