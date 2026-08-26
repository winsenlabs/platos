import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instrumentPerformanceEvidencePrisma } from "./performance-evidence.prisma";
import { PerformanceEvidenceService } from "./performance-evidence.service";

const previousEnabled = process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
const previousToken = process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;

describe("instrumentPerformanceEvidencePrisma", () => {
  beforeEach(() => {
    delete process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
    delete process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;
  });

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
    else process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED = previousEnabled;
    if (previousToken === undefined) delete process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;
    else process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN = previousToken;
  });

  it("does not register query logging or extensions unless explicitly enabled", () => {
    const prisma = { $on: vi.fn(), $extends: vi.fn() };

    expect(instrumentPerformanceEvidencePrisma(prisma, new PerformanceEvidenceService())).toBe(
      prisma
    );
    expect(prisma.$on).not.toHaveBeenCalled();
    expect(prisma.$extends).not.toHaveBeenCalled();
  });

  it("captures request context in the query extension before invoking Prisma", async () => {
    process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED = "1";
    process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN = "performance-evidence-token-for-tests";
    const extended = { kind: "extended" };
    const prisma = {
      $on: vi.fn(),
      $extends: vi.fn((_extension: unknown) => extended),
    };
    const evidence = new PerformanceEvidenceService();
    const runQueryInvocation = vi.spyOn(evidence, "runQueryInvocation");

    expect(instrumentPerformanceEvidencePrisma(prisma, evidence)).toBe(extended);
    const extension = prisma.$extends.mock.calls[0][0] as {
      query: {
        $allOperations(input: {
          args: unknown;
          query: (args: unknown) => Promise<unknown>;
        }): Promise<unknown>;
      };
    };
    const query = vi.fn(async () => "result");
    await expect(extension.query.$allOperations({ args: { take: 1 }, query })).resolves.toBe(
      "result"
    );
    expect(runQueryInvocation).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({ take: 1 });
    expect(prisma.$on).toHaveBeenCalledWith("query", expect.any(Function));
  });
});
