import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../auth/scope.guard";
import { buildEntityToolHandlers } from "./entities";
import { buildOrchestrationToolHandlers } from "./orchestration";

const scope: RequestScope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "user-1",
  principal: "operator",
};

describe("unsupported canonical control surfaces", () => {
  it.each([
    "entities.get_linked_agents",
    "entities.set_linked_agents",
    "entities.get_test_credentials",
    "entities.set_test_credentials",
  ])("fails closed for %s", async (name) => {
    const toolAudit = { record: vi.fn().mockResolvedValue(undefined) };
    const messageCrypto = {
      decryptJsonField: vi.fn(),
      encryptJsonField: vi.fn(),
    };
    const handlers = buildEntityToolHandlers({
      auth: { getEntity: vi.fn().mockResolvedValue({ id: "entity-pk" }) } as any,
      toolExecutor: {} as any,
      toolRegistry: {} as any,
      bearerTokens: {} as any,
      messageCrypto: messageCrypto as any,
      toolAudit: toolAudit as any,
      prisma: {} as any,
    });
    const handler = handlers.find((candidate) => candidate.name === name)!;

    const result = await handler.execute(
      {
        entityId: "entity-1",
        agentIds: ["agent-1"],
        testCredentials: {
          headers: [{ name: "Authorization", value: "sentinel-secret" }],
        },
      },
      scope,
      {} as any
    );

    expect(result).toMatchObject({ error: "unsupported" });
    expect(messageCrypto.decryptJsonField).not.toHaveBeenCalled();
    expect(messageCrypto.encryptJsonField).not.toHaveBeenCalled();
  });

  it("rejects contextMapping before creating an agent", async () => {
    const create = vi.fn();
    const handlers = buildOrchestrationToolHandlers({
      agentCrud: { create } as any,
      auth: {} as any,
      skillRegistry: {} as any,
      memory: {} as any,
      goldenSet: {} as any,
      prisma: {} as any,
    });
    const handler = handlers.find((candidate) => candidate.name === "agents.deploy_with_skills")!;

    const result = await handler.execute(
      {
        name: "Agent",
        model: "model",
        skillSlugs: [],
        contextMapping: { promptVars: ["email"] },
      },
      scope,
      {} as any
    );

    expect(result).toEqual({
      error: "unsupported",
      message: "contextMapping is not supported by the canonical control schema",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
