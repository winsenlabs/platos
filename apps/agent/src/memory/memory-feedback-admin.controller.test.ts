import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { MemoryFeedbackAdminController } from "./memory-feedback-admin.controller";

const requestScope = {
  organizationId: "forged-organization",
  projectId: "forged-project",
  environmentId: "authorized-environment",
  userId: "operator-user",
  principal: "operator" as const,
};

const authorization = {
  organizationId: "canonical-organization",
  projectId: "canonical-project",
  environmentId: "authorized-environment",
};

function request(scope: unknown) {
  return { scope } as any;
}

describe("MemoryFeedbackAdminController", () => {
  it("rejects end-user principals before authorization or backfill", async () => {
    const backfill = { runBatch: vi.fn() };
    const auth = { authorizeEnvironmentOperatorScope: vi.fn() };
    const controller = new MemoryFeedbackAdminController(backfill as any, auth as any);

    await expect(
      controller.runBackfill(request({ ...requestScope, principal: "end-user" }), { limit: 10 })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.authorizeEnvironmentOperatorScope).not.toHaveBeenCalled();
    expect(backfill.runBatch).not.toHaveBeenCalled();
  });

  it("rejects operators without an environment admin role", async () => {
    const backfill = { runBatch: vi.fn() };
    const auth = {
      authorizeEnvironmentOperatorScope: vi.fn(async () => {
        throw new Error("environment_forbidden");
      }),
    };
    const controller = new MemoryFeedbackAdminController(backfill as any, auth as any);

    await expect(controller.runBackfill(request(requestScope), { limit: 10 })).rejects.toThrow(
      "environment_forbidden"
    );
    expect(auth.authorizeEnvironmentOperatorScope).toHaveBeenCalledWith(
      requestScope,
      "secret:mutate"
    );
    expect(backfill.runBatch).not.toHaveBeenCalled();
  });

  it.each(["project admin", "organization admin"])(
    "allows a canonical %s scope and returns only secret-safe counts",
    async () => {
      const result = {
        scanned: 100,
        quarantined: 3,
        alreadyQuarantined: 2,
        decryptUnavailable: 0,
        completed: false,
      };
      const backfill = { runBatch: vi.fn(async () => result) };
      const auth = { authorizeEnvironmentOperatorScope: vi.fn(async () => authorization) };
      const controller = new MemoryFeedbackAdminController(backfill as any, auth as any);

      await expect(controller.runBackfill(request(requestScope), { limit: 100 })).resolves.toEqual(
        result
      );
      expect(backfill.runBatch).toHaveBeenCalledWith(authorization, { limit: 100 });
      expect(JSON.stringify(result)).not.toMatch(
        /id|content|comment|metadata|ciphertext|encryption|key material/i
      );
    }
  );

  it("does not invoke backfill when canonical ancestry rejects a forged scope", async () => {
    const backfill = { runBatch: vi.fn() };
    const auth = {
      authorizeEnvironmentOperatorScope: vi.fn(async () => {
        throw new Error("environment_forbidden");
      }),
    };
    const controller = new MemoryFeedbackAdminController(backfill as any, auth as any);

    await expect(
      controller.runBackfill(
        request({ ...requestScope, environmentId: "cross-environment" }),
        { limit: 100 }
      )
    ).rejects.toThrow("environment_forbidden");
    expect(backfill.runBatch).not.toHaveBeenCalled();
  });
});
