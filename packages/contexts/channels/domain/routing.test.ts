import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId } from "./identifiers.js";
import {
  inheritRouting,
  matchesPrefix,
  MAX_AGENT_ROUTING_RULES,
  normalizeAgentRouting,
  referencedAgentIds,
  resolveAgent,
  type ChannelRoutingRule,
} from "./routing.js";

const agent = (value: string): AgentId => asIdentifier<AgentId>(value);

function channelRule(id: string, agentValue = "a1"): ChannelRoutingRule {
  return { match: { type: "channel", id }, agentId: agent(agentValue) };
}

function prefixRule(value: string, agentValue = "a1"): ChannelRoutingRule {
  return { match: { type: "prefix", value }, agentId: agent(agentValue) };
}

function unwrapRules(raw: unknown): readonly ChannelRoutingRule[] {
  const result = normalizeAgentRouting(raw);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("normalizeAgentRouting", () => {
  it("treats null and undefined as an empty table", () => {
    expect(unwrapRules(null)).toEqual([]);
    expect(unwrapRules(undefined)).toEqual([]);
  });

  it("normalizes a channel rule and drops keys it does not know", () => {
    const rules = unwrapRules([{ match: { type: "channel", id: " C123 ", extra: 1 }, agentId: " a1 ", other: 2 }]);
    expect(rules).toEqual([{ match: { type: "channel", id: "C123" }, agentId: "a1" }]);
  });

  it("lower-cases a prefix value so the stored table and the reader agree", () => {
    expect(unwrapRules([{ match: { type: "prefix", value: "AdA" }, agentId: "a1" }])).toEqual([
      { match: { type: "prefix", value: "ada" }, agentId: "a1" },
    ]);
  });

  it("accepts a match type in any case", () => {
    expect(unwrapRules([{ match: { type: " CHANNEL ", id: "C1" }, agentId: "a1" }])).toEqual([
      { match: { type: "channel", id: "C1" }, agentId: "a1" },
    ]);
  });

  it("preserves order, because first-match-wins depends on it", () => {
    const rules = unwrapRules([
      { match: { type: "channel", id: "C1" }, agentId: "first" },
      { match: { type: "channel", id: "C2" }, agentId: "second" },
    ]);
    expect(rules.map((rule) => rule.agentId)).toEqual(["first", "second"]);
  });

  it("does NOT de-duplicate repeated rules", () => {
    const rules = unwrapRules([
      { match: { type: "channel", id: "C1" }, agentId: "first" },
      { match: { type: "channel", id: "C1" }, agentId: "second" },
    ]);
    expect(rules).toHaveLength(2);
  });

  it("admits exactly the cap and rejects one more", () => {
    // SELF-REFERENTIAL BY DESIGN, and that is the whole of what it proves: the
    // enforcement and the exported constant agree, WHATEVER the constant says.
    // It is not a pin on the value — rewriting the constant to 8 leaves this
    // case green, which is exactly the gap the next case closes.
    const rule = { match: { type: "channel", id: "C1" }, agentId: "a1" };
    expect(unwrapRules(Array.from({ length: MAX_AGENT_ROUTING_RULES }, () => rule))).toHaveLength(
      MAX_AGENT_ROUTING_RULES,
    );
    const tooMany = normalizeAgentRouting(Array.from({ length: MAX_AGENT_ROUTING_RULES + 1 }, () => rule));
    expect(tooMany.ok).toBe(false);
  });

  it("pins the cap at 32 — the preserved value, not merely 'a cap'", () => {
    // PRESERVED, NOT REINVENTED. 32 is the cap the live tree already enforces
    // in `apps/agent/src/agent-runtime/channel-routing.ts`; this context
    // transcribes that number rather than choosing a new one, so a routing
    // table an operator already stores keeps validating after the cutover.
    // Narrowing it silently invalidates stored rows; widening it silently
    // accepts tables the live tree would reject. Both are migrations, not
    // edits, so the number is pinned here rather than left to a constant.
    //
    // Every quantity below is spelled as a LITERAL, never as
    // MAX_AGENT_ROUTING_RULES, because the point is to go red when the constant
    // moves. The control is bidirectional: narrowing the cap turns the
    // 32-admission red, widening it turns the 33-rejection red, and either
    // direction turns the equality and the message red.
    const rule = { match: { type: "channel", id: "C1" }, agentId: "a1" };

    expect(MAX_AGENT_ROUTING_RULES).toBe(32);
    expect(unwrapRules(Array.from({ length: 32 }, () => rule))).toHaveLength(32);

    const tooMany = normalizeAgentRouting(Array.from({ length: 33 }, () => rule));
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    // The operator-facing message carries the number too, so a cap moved by
    // editing only the interpolated text cannot slip past either.
    expect(tooMany.error.message).toBe("agentRouting supports at most 32 rules");
  });

  it("rejects a non-array table", () => {
    const result = normalizeAgentRouting({ match: { type: "channel", id: "C1" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ROUTING_INVALID");
  });

  it.each([
    ["a non-object rule", ["nope"], "rule[0] must be an object"],
    ["a missing match", [{ agentId: "a1" }], "rule[0].match must be an object"],
    ["a missing agentId", [{ match: { type: "channel", id: "C1" } }], "rule[0].agentId is required"],
    ["a blank agentId", [{ match: { type: "channel", id: "C1" }, agentId: "   " }], "rule[0].agentId is required"],
    ["an unknown match type", [{ match: { type: "regex", value: "x" }, agentId: "a1" }], 'rule[0].match.type must be "channel" or "prefix"'],
    ["a channel rule with no id", [{ match: { type: "channel" }, agentId: "a1" }], 'rule[0].match.id is required for a "channel" rule'],
    ["a prefix rule with no value", [{ match: { type: "prefix" }, agentId: "a1" }], 'rule[0].match.value is required for a "prefix" rule'],
  ])("rejects %s", (_label, raw, message) => {
    const result = normalizeAgentRouting(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe(message);
  });

  it("names the offending index, not just the failure", () => {
    const result = normalizeAgentRouting([
      { match: { type: "channel", id: "C1" }, agentId: "a1" },
      { match: { type: "channel", id: "C2" }, agentId: "a2" },
      { match: { type: "nope" }, agentId: "a3" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("rule[2]");
  });
});

describe("referencedAgentIds", () => {
  it("returns distinct ids in first-seen order", () => {
    expect(referencedAgentIds([channelRule("C1", "b"), channelRule("C2", "a"), channelRule("C3", "b")])).toEqual([
      "b",
      "a",
    ]);
  });

  it("is empty for an empty table, so the guard can skip the round trip", () => {
    expect(referencedAgentIds([])).toEqual([]);
  });
});

describe("matchesPrefix", () => {
  it("matches the colon form and the at form", () => {
    expect(matchesPrefix("ada: hello", "ada")).toBe(true);
    expect(matchesPrefix("@ada hello", "ada")).toBe(true);
  });

  it("is case-insensitive on the incoming side", () => {
    expect(matchesPrefix("ADA: hello", "ada")).toBe(true);
    expect(matchesPrefix("@AdA hello", "ada")).toBe(true);
  });

  it("ignores leading whitespace so an indented message still routes", () => {
    expect(matchesPrefix("   ada: hello", "ada")).toBe(true);
  });

  it("does not match the name in the middle of a message", () => {
    expect(matchesPrefix("ask ada: hello", "ada")).toBe(false);
  });

  it("requires the separator, so a longer name is not a match", () => {
    // "adam" must not be routed by a rule for "ada": without the ":" the
    // colon form is not satisfied, and the "@" form needs the "@".
    expect(matchesPrefix("adam speaking", "ada")).toBe(false);
  });
});

describe("resolveAgent", () => {
  const subject = { platformChannelId: "C1", text: "hello" };

  it("falls back to the default when no rule matches", () => {
    expect(resolveAgent([channelRule("C9")], agent("fallback"), subject)).toBe("fallback");
  });

  it("returns null when nothing matches and there is no default", () => {
    expect(resolveAgent([], null, subject)).toBeNull();
  });

  it("returns the FIRST matching rule, not the last or the most specific", () => {
    const rules = [channelRule("C1", "first"), channelRule("C1", "second")];
    expect(resolveAgent(rules, agent("fallback"), subject)).toBe("first");
  });

  it("matches a channel rule on the platform channel id", () => {
    expect(resolveAgent([channelRule("C1", "routed")], agent("fallback"), subject)).toBe("routed");
  });

  it("does not match a channel rule when the message carries no channel id", () => {
    const rules = [channelRule("C1", "routed")];
    expect(resolveAgent(rules, agent("fallback"), { platformChannelId: null, text: "hello" })).toBe("fallback");
  });

  it("matches a prefix rule on the message text", () => {
    const rules = [prefixRule("ada", "routed")];
    expect(resolveAgent(rules, agent("fallback"), { platformChannelId: null, text: "ada: hi" })).toBe("routed");
  });

  it("lets an earlier prefix rule win over a later channel rule", () => {
    const rules = [prefixRule("ada", "by-prefix"), channelRule("C1", "by-channel")];
    expect(resolveAgent(rules, agent("fallback"), { platformChannelId: "C1", text: "ada: hi" })).toBe("by-prefix");
  });

  it("is total: a malformed stored rule is skipped, never fatal", () => {
    // Reaches the read path the way an older binary's row would — the strict
    // write-time half is what makes this a compatibility affordance.
    const rules = [
      null,
      { match: null, agentId: "x" },
      { match: { type: "channel" }, agentId: "x" },
      { match: { type: "channel", id: "C1" }, agentId: "" },
      { match: { type: "prefix", value: "" }, agentId: "x" },
      channelRule("C1", "survivor"),
    ] as unknown as readonly ChannelRoutingRule[];
    expect(resolveAgent(rules, agent("fallback"), subject)).toBe("survivor");
  });

  it("tolerates a non-string text without throwing", () => {
    const subjectWithBadText = { platformChannelId: null, text: undefined as unknown as string };
    expect(resolveAgent([prefixRule("ada")], agent("fallback"), subjectWithBadText)).toBe("fallback");
  });
});

describe("inheritRouting", () => {
  it("prefers the installation's own table", () => {
    const installation = [channelRule("C1", "install")];
    const app = [channelRule("C2", "app")];
    expect(inheritRouting(installation, app)).toBe(installation);
  });

  it("falls back to the app's table when the installation has none", () => {
    const app = [channelRule("C2", "app")];
    expect(inheritRouting([], app)).toBe(app);
  });

  it("treats an EMPTY installation table as no override, not as an override with nothing", () => {
    // The column defaults to []. Treating that as an override would silently
    // disable every app-level rule the moment an installation row was created.
    const app = [channelRule("C2", "app")];
    expect(inheritRouting([], app)).toHaveLength(1);
  });
});
