import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "../agent-runtime/agent.controller";
import {
  CONVERSATION_REVISION_NOT_SUPPORTED,
  ConversationRevisionNotSupportedError,
} from "./conversation.service";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  userId: "user",
  agentId: "agent",
} as any;

function controllerHarness() {
  const controller: any = Object.create(AgentController.prototype);
  controller.conversationService = {
    editAndRerun: vi.fn().mockRejectedValue(new ConversationRevisionNotSupportedError()),
    retryAssistantTurn: vi.fn().mockRejectedValue(new ConversationRevisionNotSupportedError()),
  };
  return { controller, req: { scope } as any };
}

describe("conversation revision endpoint contract", () => {
  it.each([
    [
      "edit and rerun",
      async (controller: AgentController, req: any) => controller.editAndRerun(
        req,
        "thread-1",
        "turn-1",
        { content: "replacement" },
      ),
    ],
    [
      "assistant retry",
      async (controller: AgentController, req: any) => controller.retryAssistant(
        req,
        "thread-1",
        "turn-1",
      ),
    ],
  ])("returns a stable HTTP 409 for disabled %s", async (_label, invoke) => {
    const { controller, req } = controllerHarness();

    const error = await invoke(controller, req).catch((value) => value);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toEqual(CONVERSATION_REVISION_NOT_SUPPORTED);
  });
});
