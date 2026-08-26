import { describe, expect, it, vi } from "vitest";
import { JobExecutionController } from "./job-execution.controller";

function responseMock() {
  return { status: vi.fn() };
}

const body = {
  requestId: "run-a",
  jobId: "job-a",
  payload: {},
  scope: {
    organizationId: "org-a",
    projectId: "project-a",
    environmentId: "env-a",
  },
  invokedBy: "manual",
};

describe("JobExecutionController", () => {
  it("rejects missing and invalid internal authentication before dispatch", async () => {
    const executionService = { execute: vi.fn() };
    const controller = new JobExecutionController(executionService as any);

    const missingResponse = responseMock();
    const missing = await controller.execute(
      { headers: {} } as any,
      missingResponse as any,
      body,
    );
    const invalidResponse = responseMock();
    const invalid = await controller.execute(
      { headers: { "x-platos-internal-auth": "wrong-length-token" } } as any,
      invalidResponse as any,
      body,
    );

    expect(missingResponse.status).toHaveBeenCalledWith(401);
    expect(missing).toEqual({
      status: "failed",
      error: { code: "INTERNAL_AUTH_REQUIRED" },
    });
    expect(invalidResponse.status).toHaveBeenCalledWith(401);
    expect(invalid).toEqual({
      status: "failed",
      error: { code: "INTERNAL_AUTH_INVALID" },
    });
    expect(executionService.execute).not.toHaveBeenCalled();
  });

  it("rejects a same-length invalid token", async () => {
    const executionService = { execute: vi.fn() };
    const controller = new JobExecutionController(executionService as any);
    const response = responseMock();

    const result = await controller.execute(
      { headers: { "x-platos-internal-auth": "xxxxx-secret-for-test" } } as any,
      response as any,
      body,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(result).toEqual({
      status: "failed",
      error: { code: "INTERNAL_AUTH_INVALID" },
    });
    expect(executionService.execute).not.toHaveBeenCalled();
  });

  it("parses and dispatches an authenticated strict request", async () => {
    const executionService = {
      execute: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: { status: "completed", result: { ok: true } },
      }),
    };
    const controller = new JobExecutionController(executionService as any);
    const response = responseMock();

    const result = await controller.execute(
      {
        headers: { "x-platos-internal-auth": "admin-secret-for-test" },
      } as any,
      response as any,
      body,
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(executionService.execute).toHaveBeenCalledWith(body);
    expect(result).toEqual({ status: "completed", result: { ok: true } });
  });

  it("discards unexpected service errors", async () => {
    const executionService = {
      execute: vi.fn().mockRejectedValue(
        new Error("postgresql://writer:secret@db.internal/platos raw upstream body"),
      ),
    };
    const controller = new JobExecutionController(executionService as any);
    const response = responseMock();

    const result = await controller.execute(
      { headers: { "x-platos-internal-auth": "admin-secret-for-test" } } as any,
      response as any,
      body,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(result).toEqual({
      status: "failed",
      error: { code: "JOB_SERVICE_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("writer:secret");
  });
});
