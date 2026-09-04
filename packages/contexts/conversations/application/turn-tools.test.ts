// The tool half of a turn, and the rule that keeps it an authorization decision.
//
// Mutations M-T1 (the not-offered check in `executeToolCall`), M-T2 (the scrub),
// M-T3 (the approval branch), M-T4 (the catalogue ceiling reaching the composer).

import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "@platos/context-providers";
import type { EnvironmentScope } from "@platos/kernel";

import { composeTurnSurface, executeToolCall, toToolDefinitions } from "./turn-tools.js";
import {
  AGENT_ID,
  buildConversationsTestContext,
  runtimeGrant,
  THREAD_ID,
} from "./testing/index.js";
import { buildToolCatalogue, DEFAULT_CONVERSATIONS_POLICY, type OfferedTool } from "../domain/index.js";

const SCOPE = {
  level: "environment",
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
} as EnvironmentScope;

function call(toolName: string, input: unknown = {}): ToolCallPart {
  return { kind: "tool-call", toolCallId: "call-1", toolName, input };
}

function catalogue(names: readonly string[]) {
  const offers: OfferedTool[] = names.map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    source: "tools",
  }));
  const built = buildToolCatalogue(offers, 100);
  if (!built.ok) throw new Error(built.error.code);
  return built.value;
}

function executionContext(names: readonly string[]) {
  return {
    scope: SCOPE,
    vaultAuthorization: runtimeGrant(),
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    endUserId: null,
    catalogue: catalogue(names),
  };
}

describe("composeTurnSurface", () => {
  it("joins the base prompt to the skill runtime and offers the skill's tools", async () => {
    const context = buildConversationsTestContext();
    context.skills.tools = [
      { name: "lookup", description: "look it up", inputSchema: { type: "object" } },
    ];

    const surface = await composeTurnSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      agentId: AGENT_ID,
      environmentSkillIds: ["skill-1"],
      basePrompt: "BASE. ",
      toolQuery: "",
    });
    expect(surface.ok).toBe(true);
    if (!surface.ok) return;
    expect(surface.value.systemPrompt).toBe("BASE. You are a test agent.");
    expect(surface.value.catalogue.tools.map((tool) => tool.name)).toEqual(["lookup"]);
  });

  it("offers NO registry tool when the query is empty, and does not call `tools`", async () => {
    const context = buildConversationsTestContext();
    context.tools.found = [
      { toolName: "search", description: "search", paramSchema: { type: "object" } },
    ];
    const surface = await composeTurnSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      agentId: AGENT_ID,
      environmentSkillIds: [],
      basePrompt: "",
      toolQuery: "",
    });
    if (!surface.ok) throw new Error(surface.error.code);
    expect(surface.value.catalogue.tools).toEqual([]);
  });

  it("merges registry tools when a query is given, skills first", async () => {
    const context = buildConversationsTestContext();
    context.skills.tools = [{ name: "lookup", description: "l", inputSchema: null }];
    context.tools.found = [
      { toolName: "search", description: "search", paramSchema: { type: "object" } },
    ];
    const surface = await composeTurnSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      agentId: AGENT_ID,
      environmentSkillIds: [],
      basePrompt: "",
      toolQuery: "anything",
    });
    if (!surface.ok) throw new Error(surface.error.code);
    expect(surface.value.catalogue.tools.map((tool) => tool.source)).toEqual(["skills", "tools"]);
  });

  it("refuses a catalogue over the ceiling", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      turn: { ...DEFAULT_CONVERSATIONS_POLICY.turn, maxToolsPerTurn: 1 },
    });
    context.skills.tools = [
      { name: "a", description: "a", inputSchema: null },
      { name: "b", description: "b", inputSchema: null },
    ];
    const refused = await composeTurnSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      agentId: AGENT_ID,
      environmentSkillIds: [],
      basePrompt: "",
      toolQuery: "",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TOOL_CATALOGUE_EXCEEDED");
  });

  it("returns `skills`' refusal unchanged rather than re-coding it", async () => {
    const context = buildConversationsTestContext();
    context.skills.failWith("the loadout is unreadable");
    const refused = await composeTurnSurface(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      agentId: AGENT_ID,
      environmentSkillIds: [],
      basePrompt: "",
      toolQuery: "",
    });
    expect(refused.ok).toBe(false);
  });
});

describe("toToolDefinitions", () => {
  it("hands `providers` the name, the description and the schema, and no source", () => {
    const definitions = toToolDefinitions(catalogue(["alpha", "beta"]));
    expect(definitions.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
    expect(definitions[0]).not.toHaveProperty("source");
  });
});

describe("executeToolCall", () => {
  it("runs an OFFERED tool and answers a successful result", async () => {
    const context = buildConversationsTestContext();
    context.tools.result = { rows: 3 };
    const answered = await executeToolCall(
      context.dependencies,
      executionContext(["search"]),
      call("search"),
    );
    expect(answered.failed).toBe(false);
    expect(answered.output).toEqual({ rows: 3 });
    expect(context.tools.dispatched).toEqual(["search"]);
  });

  it("REFUSES a tool the turn was not offered, and never dispatches it", async () => {
    const context = buildConversationsTestContext();
    const answered = await executeToolCall(
      context.dependencies,
      executionContext(["search"]),
      call("delete_everything"),
    );
    expect(answered.failed).toBe(true);
    expect(answered.output).toEqual({ error: "CONVERSATIONS_TOOL_NOT_OFFERED" });
    // The catalogue IS the decision. A hallucinated name must not reach the
    // dispatcher on the strength of the model having said it.
    expect(context.tools.dispatched).toEqual([]);
  });

  it("NEVER rejects: a peer refusal comes back as a failed result", async () => {
    const context = buildConversationsTestContext();
    context.tools.failWith("the tool blew up");
    const answered = await executeToolCall(
      context.dependencies,
      executionContext(["search"]),
      call("search"),
    );
    // A rejected promise ends the whole generation. The model is told instead,
    // and can often recover on the next step.
    expect(answered.failed).toBe(true);
    expect(answered.kind).toBe("tool-result");
    expect(answered.toolCallId).toBe("call-1");
  });

  it("answers an APPROVAL requirement as a failed result rather than blocking", async () => {
    const context = buildConversationsTestContext();
    context.tools.awaitingApproval = true;
    const answered = await executeToolCall(
      context.dependencies,
      executionContext(["search"]),
      call("search"),
    );
    expect(answered.failed).toBe(true);
    expect(String((answered.output as { error: string }).error)).toContain("approval required");
    // The source blocks the turn on a Redis BLPOP for up to five minutes.
  });

  it("SCRUBS the result, so a Map does not become an empty object downstream", async () => {
    const context = buildConversationsTestContext();
    context.tools.result = { rows: new Map([["a", 1]]), id: 7n };
    const answered = await executeToolCall(
      context.dependencies,
      executionContext(["search"]),
      call("search"),
    );
    expect(answered.failed).toBe(false);
    expect(answered.output).toEqual({ rows: { a: 1 }, id: "7" });
  });

  it("fails a tool whose answer will not serialize at all", async () => {
    const context = buildConversationsTestContext();
    context.tools.result = null;
    const answered = await executeToolCall(
      context.dependencies,
      executionContext(["search"]),
      call("search"),
    );
    expect(answered.failed).toBe(true);
    expect(answered.output).toEqual({ error: "the tool answered with nothing" });
  });

  it("keeps the call's own correlation id on every outcome", async () => {
    const context = buildConversationsTestContext();
    const refused = await executeToolCall(
      context.dependencies,
      executionContext([]),
      call("nope"),
    );
    expect(refused.toolCallId).toBe("call-1");
    expect(refused.toolName).toBe("nope");
  });
});
