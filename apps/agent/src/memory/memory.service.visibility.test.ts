import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "./memory.service";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce",
  agentId: "3ec2a3f1-10f9-41a7-9e21-3b6739e84ca1",
};

function row(agentVisible: boolean, visibility: "agent_visible" | "hidden" | "private") {
  return {
    id: "ca933c02-d80d-4759-aed2-9d63ebb74a23",
    environmentId: scope.environmentId,
    endUserId: "0f2e2f4c-5246-4495-980c-9fd7e99da9fb",
    agentId: scope.agentId,
    kind: "profile",
    content: "remember this",
    metadata: { profileKey: "visibility-test" },
    agentVisible,
    visibility,
    source: "manual",
    sourceTurnIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("MemoryService visibility compatibility", () => {
  it("persists a hidden legacy toggle with agentVisible false", async () => {
    const database = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    } as any;
    const service = new MemoryService(database, {} as any);
    vi.spyOn(service, "get")
      .mockResolvedValueOnce({ ...row(true, "agent_visible"), userId: "external-user" } as any)
      .mockResolvedValueOnce({ ...row(false, "hidden"), userId: "external-user" } as any);

    const result = await service.update(scope, "ca933c02-d80d-4759-aed2-9d63ebb74a23", { agentVisible: false }, "external-user");

    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      "profile",
      "remember this",
      '{"profileKey":"visibility-test"}',
      false,
      "hidden",
      null,
      null,
      "ca933c02-d80d-4759-aed2-9d63ebb74a23",
      scope.environmentId,
    );
    expect(result).toMatchObject({ agentVisible: false, visibility: "hidden" });
  });
});
