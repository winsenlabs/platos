import { describe, expect, it, vi } from "vitest";
import { ModelRateSource } from "@platos/tenancy-database";

const generateText = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateText }));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: vi.fn(() => ({ provider: "anthropic" })),
  createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic" }))),
}));
vi.mock("@ai-sdk/openai", () => ({
  openai: vi.fn(() => ({ provider: "openai" })),
  createOpenAI: vi.fn(() => vi.fn(() => ({ provider: "openai" }))),
}));
vi.mock("@ai-sdk/google", () => ({
  google: vi.fn(() => ({ provider: "google" })),
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({ provider: "google" }))),
}));

import { EvalService } from "./eval.service";

describe("EvalService clean Turn projection", () => {
  it("builds the judge transcript from Turn input/output and persists the sampled Turn id", async () => {
    generateText.mockResolvedValue({
      text: '{"score":90,"rationale":"grounded","passed":true}',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const threadFindFirst = vi.fn().mockResolvedValue({
      id: "thread-a",
      agentId: "agent-a",
      agent: {
        bindings: [
          {
            activeAgentVersionId: "version-a",
            activeAgentVersion: { model: "anthropic:claude-sonnet-4-6" },
          },
        ],
      },
    });
    const turnFindMany = vi.fn().mockResolvedValue([
      {
        id: "turn-a",
        inputText: "Question from clean Turn",
        outputText: "Answer from clean Turn",
        createdAt: new Date("2026-08-15T10:00:00.000Z"),
      },
    ]);
    const agentEvalCreate = vi.fn(async ({ data }) => ({
      id: "eval-a",
      ...data,
      createdAt: new Date("2026-08-15T10:01:00.000Z"),
    }));
    const prisma = {
      thread: { findFirst: threadFindFirst },
      agent: { findFirst: vi.fn().mockResolvedValue({ id: "agent-a" }) },
      turn: { findMany: turnFindMany },
      agentEval: { create: agentEvalCreate },
    };
    const scopedEnv = { get: vi.fn().mockResolvedValue("test-openai-key") };
    const criterionService = {
      findById: vi.fn().mockResolvedValue({
        id: "criterion-a",
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
        agentId: null,
        name: "Groundedness",
        description: null,
        judgePrompt: "Judge this conversation: {conversation}",
        rubric: null,
        judgeModel: "openai:gpt-4.1-mini",
        scoreScaleMin: 0,
        scoreScaleMax: 100,
        isActive: true,
        createdBy: "user-a",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
      }),
    };
    const service = new EvalService(
      prisma as any,
      scopedEnv as any,
      criterionService as any,
      {
        resolvePrice: vi.fn().mockResolvedValue({
          input: { source: ModelRateSource.LITELLM },
          output: { source: ModelRateSource.LITELLM },
        }),
        priceUsageFromSnapshot: vi.fn().mockReturnValue({ costCents: 0 }),
        recordAuxiliaryCost: vi.fn(),
      } as any,
    );
    const scope = {
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      userId: "user-a",
    };

    const result = await service.runJudge(scope, {
      agentId: "agent-a",
      threadId: "thread-a",
      criterionId: "criterion-a",
      messageId: "turn-a",
    });

    expect(threadFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "thread-a",
          environmentId: "env-a",
          environment: {
            project: { id: "project-a", organizationId: "org-a" },
          },
        },
      }),
    );
    expect(turnFindMany).toHaveBeenCalledWith({
      where: {
        threadId: "thread-a",
        status: { not: "CANCELLED" },
        id: "turn-a",
      },
      select: { id: true, inputText: true, outputText: true, createdAt: true },
      orderBy: { sequence: "asc" },
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining(
              "USER: Question from clean Turn\n\nASSISTANT: Answer from clean Turn",
            ),
          }),
        ],
      }),
    );
    expect(agentEvalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        environmentId: "env-a",
        threadId: "thread-a",
        turnId: "turn-a",
        agentVersionId: "version-a",
      }),
    });
    expect(result).toMatchObject({
      id: "eval-a",
      messageId: "turn-a",
      score: 90,
      passed: true,
    });
  });
});
