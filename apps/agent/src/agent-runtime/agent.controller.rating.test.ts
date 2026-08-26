import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RatingMutationForbiddenError } from "../evals/rating.service";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
  userId: "operator-a",
  principal: "operator" as const,
};

function harness() {
  const ratingService = {
    upsert: vi.fn().mockRejectedValue(new RatingMutationForbiddenError()),
    remove: vi.fn().mockRejectedValue(new RatingMutationForbiddenError()),
  };
  const controller: any = Object.create(AgentController.prototype);
  controller.ratingService = ratingService;
  return { controller, ratingService, req: { scope } as any };
}

describe("AgentController rating actor boundary", () => {
  it.each([
    ["POST", (controller: any, req: any) => controller.rateMessage(req, "turn-a", { rating: 1 })],
    ["DELETE", (controller: any, req: any) => controller.unrateMessage(req, "turn-a")],
  ])("maps denied operator %s mutations to the stable 403 contract", async (_method, invoke) => {
    const { controller, req } = harness();

    const rejection = await invoke(controller, req).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ForbiddenException);
    expect((rejection as ForbiddenException).getStatus()).toBe(403);
    expect((rejection as ForbiddenException).getResponse()).toEqual({
      code: "RATING_ACTOR_FORBIDDEN",
      message: "Operator principals cannot mutate EndUser ratings",
    });
  });
});
