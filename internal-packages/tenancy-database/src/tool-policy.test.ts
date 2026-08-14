import { AgentToolDefaultPolicy, PolicyEffect } from "../generated/control";
import { describe, expect, test } from "vitest";
import { resolveAgentToolIds } from "./tool-policy";

describe("agent tool policy resolution", () => {
  test("gives zero-row NONE and ALL distinct unlisted-tool behavior", () => {
    expect(resolveAgentToolIds(AgentToolDefaultPolicy.NONE, [], ["a", "b"])).toEqual([]);
    expect(resolveAgentToolIds(AgentToolDefaultPolicy.ALL, [], ["a", "b"])).toEqual(["a", "b"]);
  });

  test("explicit rows override either default", () => {
    expect(resolveAgentToolIds(
      AgentToolDefaultPolicy.NONE,
      [{ toolId: "a", effect: PolicyEffect.ALLOW }],
      ["a", "b"]
    )).toEqual(["a"]);
    expect(resolveAgentToolIds(
      AgentToolDefaultPolicy.ALL,
      [{ toolId: "a", effect: PolicyEffect.DENY }],
      ["a", "b"]
    )).toEqual(["b"]);
  });
});
