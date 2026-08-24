import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
  principal: "operator" as const,
};
const KEY_HASH = "a".repeat(64);
const KEY_PREFIX = "platos_live_test";
const RAW_KEY = "platos_live_RAW_SENTINEL";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function harness() {
  const authService = {
    createOrRotateAccessKey: vi.fn().mockResolvedValue({
      key: {
        id: "key_1",
        environmentId: scope.environmentId,
        keyPrefix: KEY_PREFIX,
        allowedOrigins: [],
        lastUsedAt: null,
        validUntil: null,
        replacedById: null,
        revokedAt: null,
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        updatedAt: new Date("2026-08-16T00:00:00.000Z"),
      },
      retiringKey: null,
    }),
  };
  const controller: any = Object.create(AgentController.prototype);
  controller.authService = authService;
  return { controller, authService, req: { scope } as any };
}

describe("AgentController AccessKey boundary", () => {
  it("echoes the request correlation only after hash persistence succeeds", async () => {
    const { controller, authService, req } = harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await controller.createOrRotateAccessKey(req, {
      attemptId: ATTEMPT_ID,
      keyHash: KEY_HASH,
      keyPrefix: KEY_PREFIX,
    });

    expect(authService.createOrRotateAccessKey).toHaveBeenCalledWith(scope, {
      keyHash: KEY_HASH,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.attemptId).toBe(ATTEMPT_ID);
    const serialized = JSON.stringify(result);
    const serializedLogs = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(serialized).not.toContain(KEY_HASH);
    expect(serialized).not.toContain(RAW_KEY);
    expect(serializedLogs).not.toContain(KEY_HASH);
    expect(serializedLogs).not.toContain(RAW_KEY);

    log.mockRestore();
    error.mockRestore();
  });

  it.each([
    ["missing attempt ID", { keyHash: KEY_HASH, keyPrefix: KEY_PREFIX }],
    ["malformed attempt ID", { attemptId: "not-random", keyHash: KEY_HASH, keyPrefix: KEY_PREFIX }],
    ["accessKey", { attemptId: ATTEMPT_ID, keyHash: KEY_HASH, keyPrefix: KEY_PREFIX, accessKey: RAW_KEY }],
    ["rawKey", { attemptId: ATTEMPT_ID, keyHash: KEY_HASH, keyPrefix: KEY_PREFIX, rawKey: RAW_KEY }],
    ["key", { attemptId: ATTEMPT_ID, keyHash: KEY_HASH, keyPrefix: KEY_PREFIX, key: RAW_KEY }],
    ["allowedOrigins", { attemptId: ATTEMPT_ID, keyHash: KEY_HASH, keyPrefix: KEY_PREFIX, allowedOrigins: [] }],
    [
      "nested secret-bearing field",
      { attemptId: ATTEMPT_ID, keyHash: KEY_HASH, keyPrefix: KEY_PREFIX, metadata: { accessKey: RAW_KEY } },
    ],
    ["unknown field", { attemptId: ATTEMPT_ID, keyHash: KEY_HASH, keyPrefix: KEY_PREFIX, unknown: true }],
  ])("rejects the extra %s field and does not call the service", async (_name, body) => {
    const { controller, authService, req } = harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const rejection = await controller
      .createOrRotateAccessKey(req, body)
      .catch((value: unknown) => value);

    expect(rejection).toBeInstanceOf(BadRequestException);
    expect((rejection as BadRequestException).message).toBe("invalid_access_key_material");
    expect(authService.createOrRotateAccessKey).not.toHaveBeenCalled();
    const serialized = JSON.stringify(rejection);
    const serializedLogs = JSON.stringify([...log.mock.calls, ...errorLog.mock.calls]);
    expect(serialized).not.toContain(KEY_HASH);
    expect(serialized).not.toContain(RAW_KEY);
    expect(serializedLogs).not.toContain(KEY_HASH);
    expect(serializedLogs).not.toContain(RAW_KEY);

    log.mockRestore();
    errorLog.mockRestore();
  });
});
