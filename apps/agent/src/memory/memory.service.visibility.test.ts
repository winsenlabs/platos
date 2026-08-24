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
      "visibility-test",
      "remember this",
      '{"profileKey":"visibility-test"}',
      false,
      "hidden",
      true,
      null,
      null,
      "ca933c02-d80d-4759-aed2-9d63ebb74a23",
      scope.environmentId,
    );
    expect(result).toMatchObject({ agentVisible: false, visibility: "hidden" });
  });

  it("preserves explicit private instead of applying the legacy hidden mapping", async () => {
    const database = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    } as any;
    const service = new MemoryService(database, {} as any);
    vi.spyOn(service, "get")
      .mockResolvedValueOnce({ ...row(true, "agent_visible"), userId: "external-user" } as any)
      .mockResolvedValueOnce({ ...row(false, "private"), userId: "external-user" } as any);

    await service.update(scope, row(true, "agent_visible").id, { visibility: "private" }, "external-user");

    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      "profile",
      "visibility-test",
      "remember this",
      '{"profileKey":"visibility-test"}',
      false,
      "private",
      true,
      null,
      null,
      row(true, "agent_visible").id,
      scope.environmentId,
    );
  });

  it("rejects an unknown explicit visibility instead of coercing it", async () => {
    const database = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
    } as any;
    const service = new MemoryService(database, {} as any);
    vi.spyOn(service, "get").mockResolvedValue({ ...row(true, "agent_visible"), userId: "external-user" } as any);

    await expect(service.update(
      scope,
      row(true, "agent_visible").id,
      { visibility: "cluster" as any },
      "external-user",
    )).rejects.toMatchObject({ code: "MEMORY_INVALID_VISIBILITY" });
  });

  it("embeds unchanged content when a profile becomes recallable", async () => {
    const database = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    } as any;
    const embeddings = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const service = new MemoryService(database, embeddings as any);
    vi.spyOn(service, "get")
      .mockResolvedValueOnce({ ...row(false, "private"), userId: "external-user" } as any)
      .mockResolvedValueOnce({ ...row(false, "private"), kind: "fact", metadata: null, userId: "external-user" } as any);

    await service.update(scope, row(false, "private").id, { kind: "fact", metadata: null }, "external-user");

    expect(embeddings.embed).toHaveBeenCalledWith("remember this", scope);
    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      "fact",
      null,
      "remember this",
      null,
      false,
      "private",
      false,
      "[0.1,0.2]",
      null,
      row(false, "private").id,
      scope.environmentId,
    );
  });

  it("rejects invalid and caller-asserted non-manual provenance at the service boundary", async () => {
    const database = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
      endUserIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          endUserId: "0f2e2f4c-5246-4495-980c-9fd7e99da9fb",
          subject: "external-user",
        }),
      },
      agentBinding: {
        findFirst: vi.fn().mockResolvedValue({ agentId: scope.agentId, clusterId: null }),
      },
    } as any;
    const service = new MemoryService(database, {} as any);

    await expect(service.add(scope, {
      userId: "external-user",
      content: "invalid source",
      source: "invented" as any,
    })).rejects.toMatchObject({ code: "MEMORY_INVALID_SOURCE" });

    await expect(service.add(scope, {
      userId: "external-user",
      content: "forged extraction",
      source: "extracted",
    })).rejects.toMatchObject({ code: "MEMORY_UNTRUSTED_SOURCE" });
  });

  it("uses the dual recall predicate by default and only widens for explicit management visibility", async () => {
    function semanticHarness() {
      const query = vi.fn(async (sql: string) =>
        sql.includes("pg_extension") ? [{ extversion: "0.8.0" }] : []);
      const tx = {
        $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
        $queryRawUnsafe: query,
      };
      const database = {
        environment: {
          findFirst: vi.fn()
            .mockResolvedValueOnce({ id: scope.environmentId })
            .mockResolvedValueOnce({ memoryFeedbackBackfillCompletedAt: new Date() }),
        },
        endUserIdentity: {
          findFirst: vi.fn().mockResolvedValue({
            endUserId: "0f2e2f4c-5246-4495-980c-9fd7e99da9fb",
            subject: "external-user",
          }),
        },
        agentBinding: {
          findMany: vi.fn().mockResolvedValue([{ agentId: scope.agentId, clusterId: null }]),
        },
        memory: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as any;
      const embeddings = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
      return { service: new MemoryService(database, embeddings as any), query };
    }

    const runtime = semanticHarness();
    await runtime.service.semanticSearch(scope, {
      userId: "external-user",
      query: "remember",
    });
    const runtimeSql = runtime.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM "Memory"'))!;
    expect(runtimeSql).toContain('"agentVisible" = TRUE');
    expect(runtimeSql).toContain('"visibility" = ANY');
    expect(runtime.query.mock.calls.some((call) => {
      const last = (call as unknown[]).at(-1);
      return Array.isArray(last) && last.join(",") === "agent_visible";
    })).toBe(true);

    const management = semanticHarness();
    await management.service.semanticSearch(scope, {
      userId: "external-user",
      query: "manage",
      visibilityIn: ["agent_visible", "hidden", "private"],
    });
    const managementSql = management.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM "Memory"'))!;
    expect(managementSql).not.toContain('"agentVisible" = TRUE');
    expect(management.query.mock.calls.some((call) => {
      const last = (call as unknown[]).at(-1);
      return Array.isArray(last) && last.join(",") === "agent_visible,hidden,private";
    })).toBe(true);
  });
});
