import type { ActionFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PlatosAgentApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    requireEnvironmentScope: vi.fn(),
    agentRequest: vi.fn(),
    PlatosAgentApiError,
  };
});

vi.mock("../app/services/auth.server", () => ({
  requireEnvironmentScope: mocks.requireEnvironmentScope,
}));
vi.mock("../app/services/platosAgent.server", () => ({
  agentRequest: mocks.agentRequest,
  PlatosAgentApiError: mocks.PlatosAgentApiError,
}));

import { action } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route";

const templateId = "66666666-6666-4666-8666-666666666666";
const agentId = "55555555-5555-4555-8555-555555555555";

function args(fields: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request("https://dashboard.example/postman-templates", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
      agentId,
    },
    context: {},
  };
}

describe("Postman dashboard execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireEnvironmentScope.mockResolvedValue({
      scope: {
        organizationId: "org-id",
        projectId: "project-id",
        environmentId: "environment-id",
        userId: "operator-id",
      },
    });
    mocks.agentRequest.mockResolvedValue({
      execution: {
        requestId: "88888888-8888-4888-8888-888888888888",
        templateId,
        agentId,
        simulatedEndUserId: "77777777-7777-4777-8777-777777777777",
        threadId: "99999999-9999-4999-8999-999999999999",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        turnCount: 1,
        status: "SUCCEEDED",
        outputText: "persisted answer",
      },
    });
  });

  it("submits an exact one-Turn override contract and returns safe read-back evidence", async () => {
    const response = await action(args({
      intent: "execute",
      templateId,
      message: "Check the account",
      sessionContextOverride: '{"account":"OVERRIDE_SECRET_SENTINEL"}',
    }));

    expect(response.status).toBe(200);
    expect(mocks.agentRequest).toHaveBeenCalledWith(
      `/api/v1/agent/postman-templates/${templateId}/execute`,
      expect.objectContaining({ environmentId: "environment-id" }),
      {
        method: "POST",
        body: {
          message: "Check the account",
          sessionContextOverride: { account: "OVERRIDE_SECRET_SENTINEL" },
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
        signal: expect.any(AbortSignal),
      },
    );
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      result: {
        execution: {
          templateId,
          turnCount: 1,
          status: "SUCCEEDED",
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("OVERRIDE_SECRET_SENTINEL");
    expect(JSON.stringify(payload)).not.toContain("sessionContextOverride");
  });

  it("keeps a stable role error without echoing the submitted override", async () => {
    mocks.agentRequest.mockRejectedValue(new mocks.PlatosAgentApiError(
      403,
      "POSTMAN_EXECUTION_FORBIDDEN",
      "backend detail",
    ));

    const response = await action(args({
      intent: "execute",
      templateId,
      message: "Check the account",
      sessionContextOverride: '{"account":"OVERRIDE_SECRET_SENTINEL"}',
    }));

    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: false,
      error: {
        code: "POSTMAN_EXECUTION_FORBIDDEN",
        message: "Postman template mutation failed (POSTMAN_EXECUTION_FORBIDDEN)",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("OVERRIDE_SECRET_SENTINEL");
  });

  it("rejects a malformed override before calling the Agent API", async () => {
    const response = await action(args({
      intent: "execute",
      templateId,
      message: "Check the account",
      sessionContextOverride: "[]",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "sessionContextOverride must be a JSON object" },
    });
    expect(mocks.agentRequest).not.toHaveBeenCalled();
  });
});
