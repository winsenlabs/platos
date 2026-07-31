import { describe, it, expect } from "vitest";
import {
  findDynamicExecutor,
  executorParamNames,
  isExplicitDynamicExecutor,
  looksLikeDynamicExecutor,
  looksLikeGatewaySlug,
  toolNotFoundMessage,
} from "./dynamic-executor";

/**
 * REGRESSION — gateway slug re-routing never fired in production.
 *
 * `tool-executor` re-routes an unregistered slug through a gateway's execute
 * tool, gated on `"x-dynamic-executor": true`. Nothing ever set that marker, so
 * the branch was dead: 13 distinct slugs and 28 failed calls across Slack,
 * Gmail, Google Calendar, Notion and Tavily on the live deployment.
 */

/** walle_execute_tool's REAL registered schema, copied from the live database. */
const WALLE_EXECUTE_TOOL = {
  toolName: "walle_execute_tool",
  paramSchema: {
    type: "object",
    properties: {
      args: { type: "object", description: "Alias for arguments." },
      slug: { type: "string", description: "Alias for tool_slug." },
      toolkit: { type: "string", description: "Optional toolkit slug" },
      arguments: { type: "object", description: "Arguments object for the tool" },
      tool_slug: { type: "string", description: "Exact tool slug, e.g. GMAIL_SEND_EMAIL" },
    },
  },
};

const WALLE_SEARCH_TOOLS = {
  toolName: "walle_search_tools",
  paramSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      toolkit: { type: "string" },
      limit: { type: "number" },
    },
  },
};

const ARTIFACT_SHARE = {
  toolName: "artifact_share",
  paramSchema: {
    type: "object",
    properties: { artifactId: { type: "string" }, emails: { type: "array" } },
  },
};

describe("the production bug", () => {
  it("walle_execute_tool carries NO explicit marker — this is why it broke", () => {
    expect(isExplicitDynamicExecutor(WALLE_EXECUTE_TOOL)).toBe(false);
  });

  it("but its shape is unmistakable, so it is now inferred", () => {
    expect(looksLikeDynamicExecutor(WALLE_EXECUTE_TOOL)).toBe(true);
  });

  it("SLACK_SEND_MESSAGE now re-routes instead of failing", () => {
    const found = findDynamicExecutor(
      [WALLE_SEARCH_TOOLS, WALLE_EXECUTE_TOOL, ARTIFACT_SHARE],
      "SLACK_SEND_MESSAGE",
    );
    expect(found?.toolName).toBe("walle_execute_tool");
  });

  it("every slug that failed in production now resolves", () => {
    const observed = [
      "SLACK_SEND_MESSAGE",
      "SLACK_FIND_USER_BY_EMAIL_ADDRESS",
      "SLACK_FIND_USERS",
      "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
      "GMAIL_SEND_EMAIL",
      "GOOGLECALENDAR_LIST_EVENTS",
      "NOTION_SEARCH_NOTION_PAGE",
      "TAVILY_TAVILY_SEARCH",
      "GOOGLESUPER_FETCH_EMAILS",
    ];
    for (const slug of observed) {
      expect(findDynamicExecutor([WALLE_SEARCH_TOOLS, WALLE_EXECUTE_TOOL], slug)?.toolName).toBe(
        "walle_execute_tool",
      );
      expect(looksLikeGatewaySlug(slug)).toBe(true);
    }
  });
});

describe("what must NOT be treated as a gateway", () => {
  it("a search tool is not an executor", () => {
    expect(looksLikeDynamicExecutor(WALLE_SEARCH_TOOLS)).toBe(false);
  });

  it("an ordinary tool is not an executor", () => {
    expect(looksLikeDynamicExecutor(ARTIFACT_SHARE)).toBe(false);
  });

  it("a slug param WITHOUT an arguments object does not qualify", () => {
    // Routing arbitrary calls into a lookup-by-slug tool would be worse than
    // the failure it replaces. The pair is required.
    expect(
      looksLikeDynamicExecutor({
        toolName: "lookup_by_slug",
        paramSchema: { type: "object", properties: { slug: { type: "string" } } },
      }),
    ).toBe(false);
  });

  it("an arguments object WITHOUT a slug does not qualify", () => {
    expect(
      looksLikeDynamicExecutor({
        toolName: "run_thing",
        paramSchema: { type: "object", properties: { arguments: { type: "object" } } },
      }),
    ).toBe(false);
  });

  it("never routes a call into the tool that was called", () => {
    expect(findDynamicExecutor([WALLE_EXECUTE_TOOL], "walle_execute_tool")).toBeNull();
  });

  it("returns null when no gateway exists at all", () => {
    expect(findDynamicExecutor([ARTIFACT_SHARE, WALLE_SEARCH_TOOLS], "SLACK_SEND_MESSAGE")).toBeNull();
  });

  it("tolerates junk schemas without throwing", () => {
    for (const bad of [null, undefined, "a string", 42, [], { properties: "nope" }]) {
      expect(looksLikeDynamicExecutor({ toolName: "x", paramSchema: bad })).toBe(false);
    }
  });
});

describe("executor selection is deterministic and explicit-first", () => {
  it("an explicit marker beats an inferred one", () => {
    const explicit = {
      toolName: "zz_marked_gateway",
      paramSchema: { "x-dynamic-executor": true, type: "object", properties: {} },
    };
    // Name sorts AFTER walle_execute_tool, so only the explicit rule can win.
    expect(findDynamicExecutor([WALLE_EXECUTE_TOOL, explicit], "X_Y")?.toolName).toBe(
      "zz_marked_gateway",
    );
  });

  it("ties break on name, so replicas agree", () => {
    const a = { ...WALLE_EXECUTE_TOOL, toolName: "aaa_gateway" };
    const b = { ...WALLE_EXECUTE_TOOL, toolName: "bbb_gateway" };
    expect(findDynamicExecutor([b, a], "X_Y")?.toolName).toBe("aaa_gateway");
    expect(findDynamicExecutor([a, b], "X_Y")?.toolName).toBe("aaa_gateway");
  });
});

describe("re-routing uses the gateway's own parameter names", () => {
  it("picks tool_slug + arguments for Walle", () => {
    expect(executorParamNames(WALLE_EXECUTE_TOOL)).toEqual({
      slugKey: "tool_slug",
      argsKey: "arguments",
    });
  });

  it("adapts to a gateway that named them differently", () => {
    // Hardcoding tool_slug/arguments would silently hand this gateway keys it
    // does not accept.
    expect(
      executorParamNames({
        toolName: "other_gateway",
        paramSchema: { type: "object", properties: { slug: {}, args: {} } },
      }),
    ).toEqual({ slugKey: "slug", argsKey: "args" });
  });
});

describe("the error message must not read as a broken integration", () => {
  const scope = { organizationId: "o", projectId: "p", environmentId: "e" };

  it("stops telling users to reconnect a working integration", () => {
    // The old text said "not found or not enabled for scope", which the agent
    // relayed to the operator as "Slack is connected but the send tool is
    // unavailable — check your connection". Slack was fine.
    const msg = toolNotFoundMessage("SLACK_SEND_MESSAGE", scope, false);
    expect(msg).toContain("NOT a broken integration");
    expect(msg).toContain("do not tell the user to reconnect");
  });

  it("tells the model what to do instead when a gateway IS present", () => {
    const msg = toolNotFoundMessage("SLACK_SEND_MESSAGE", scope, true);
    expect(msg).toContain("gateway tool slug");
    expect(msg).toContain("execute tool");
  });

  it("keeps the plain message for a genuinely unknown tool", () => {
    const msg = toolNotFoundMessage("some_typo_tool", scope, false);
    expect(msg).toContain("not found or not enabled for scope");
    expect(msg).not.toContain("gateway");
  });

  it("recognises gateway-shaped slugs without over-matching", () => {
    expect(looksLikeGatewaySlug("SLACK_SEND_MESSAGE")).toBe(true);
    expect(looksLikeGatewaySlug("GOOGLECALENDAR_LIST_EVENTS")).toBe(true);
    expect(looksLikeGatewaySlug("walle_execute_tool")).toBe(false);
    expect(looksLikeGatewaySlug("SLACK")).toBe(false); // no underscore
    expect(looksLikeGatewaySlug("find_tools")).toBe(false);
  });
});
