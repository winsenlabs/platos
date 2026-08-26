import type { ExecutionContext } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

const RATE_LIMIT_ENV_KEYS = [
  "PLATOS_RATE_LIMIT_PER_MIN",
  "PLATOS_RATE_LIMIT_PER_DAY",
  "PLATOS_RATE_LIMIT_USER_PER_MIN",
] as const;

describe("RateLimitGuard production defaults", () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of RATE_LIMIT_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
    vi.resetModules();
  });

  it("keeps the real Redis-backed default user limit and returns HTTP 429 on request 31", async () => {
    for (const key of RATE_LIMIT_ENV_KEYS) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    vi.resetModules();
    const { RateLimitGuard } = await import("./rate-limit.guard");

    let minuteCount = 0;
    let dayCount = 0;
    let userMinuteCount = 0;
    const pipeline = vi.fn(() => {
      const chain = {
        incr: vi.fn(() => chain),
        expire: vi.fn(() => chain),
        exec: vi.fn(async () => [
          [null, ++minuteCount],
          [null, 1],
          [null, ++dayCount],
          [null, 1],
          [null, ++userMinuteCount],
          [null, 1],
        ]),
      };
      return chain;
    });
    const response = { setHeader: vi.fn() };
    const request = {
      url: "/api/v1/memory",
      scope: {
        organizationId: "organization-id",
        projectId: "project-id",
        environmentId: "environment-id",
        userId: "end-user-id",
      },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    const guard = new RateLimitGuard({ pipeline } as never);

    for (let index = 0; index < 30; index += 1) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 429,
      response: {
        code: "rate_limit",
        scope: "user_per_minute",
        limit: 30,
      },
    });
    expect(pipeline).toHaveBeenCalledTimes(31);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });
});
