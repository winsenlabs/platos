// The catalogue: the authorization decision for every tool call a turn makes.
//
// Mutations M-G1 (the ceiling), M-G2 (the not-offered check). The second is the
// one that matters most: a model can ask for a tool it was never given, and a
// name that arrives out of nowhere has been through nobody's gate.

import { describe, expect, it } from "vitest";

import {
  buildToolCatalogue,
  EMPTY_TOOL_CATALOGUE,
  META_TOOL_OWNERS,
  requireOffered,
  TOOL_SOURCES,
  type OfferedTool,
} from "./tool-catalogue.js";

function tool(name: string, source: OfferedTool["source"] = "tools"): OfferedTool {
  return { name, description: `the ${name} tool`, inputSchema: { type: "object" }, source };
}

describe("buildToolCatalogue", () => {
  it("indexes by name and preserves the order the offers arrived in", () => {
    const built = buildToolCatalogue([tool("alpha"), tool("beta"), tool("gamma")], 10);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.tools.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(built.value.byName.get("beta")?.description).toBe("the beta tool");
  });

  it("keeps the FIRST offer of a duplicated name and drops the second, silently", () => {
    const built = buildToolCatalogue(
      [tool("search", "skills"), tool("search", "tools"), tool("other")],
      10,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.tools).toHaveLength(2);
    expect(built.value.byName.get("search")?.source).toBe("skills");
    // Refusing instead would let one badly named skill disable a whole agent's
    // catalogue, and a model cannot be given two tools with one name anyway.
  });

  it("refuses a catalogue over the ceiling, and admits exactly at it", () => {
    const tools = (count: number) =>
      Array.from({ length: count }, (_, index) => tool(`t-${index}`));
    expect(buildToolCatalogue(tools(8), 8).ok).toBe(true);
    const refused = buildToolCatalogue(tools(9), 8);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TOOL_CATALOGUE_EXCEEDED");
    expect(refused.error.details.maximum).toBe(8);
  });

  it("counts DEDUPLICATED names against the ceiling, not raw offers", () => {
    const built = buildToolCatalogue([tool("a"), tool("a"), tool("a")], 1);
    expect(built.ok).toBe(true);
  });

  it("an empty catalogue is a generation with no round trips", () => {
    const built = buildToolCatalogue([], 8);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.tools).toEqual([]);
    expect(EMPTY_TOOL_CATALOGUE.tools).toEqual([]);
  });
});

describe("requireOffered", () => {
  it("answers a tool that was in the catalogue", () => {
    const built = buildToolCatalogue([tool("search")], 8);
    if (!built.ok) throw new Error(built.error.code);
    const offered = requireOffered(built.value, "search");
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    expect(offered.value.name).toBe("search");
  });

  it("REFUSES a name that was never offered, as forbidden rather than not_found", () => {
    const built = buildToolCatalogue([tool("search")], 8);
    if (!built.ok) throw new Error(built.error.code);
    const refused = requireOffered(built.value, "delete_everything");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TOOL_NOT_OFFERED");
    // `forbidden`, not `not_found`: the tool may well exist, and this turn was
    // not given it.
    expect(refused.error.category).toBe("forbidden");
    expect(refused.error.details.toolName).toBe("delete_everything");
  });

  it("refuses every name in an EMPTY catalogue", () => {
    expect(requireOffered(EMPTY_TOOL_CATALOGUE, "anything").ok).toBe(false);
  });
});

describe("META_TOOL_OWNERS — where the source's meta-tools went", () => {
  it("names only contexts this one is permitted to depend on", () => {
    for (const source of Object.values(META_TOOL_OWNERS)) {
      expect(TOOL_SOURCES).toContain(source);
    }
  });

  it("assigns every memory operation to `memory`, none of them here", () => {
    for (const name of ["remember", "recall", "forget", "list_memories", "relate"]) {
      expect(META_TOOL_OWNERS[name]).toBe("memory");
    }
  });

  it("assigns every durable dispatch and both approvals to `jobs`", () => {
    for (const name of ["spawn_job", "dispatch_job", "request_approval", "request_durable_approval"]) {
      expect(META_TOOL_OWNERS[name]).toBe("jobs");
    }
  });

  it("assigns the discovery pair to `tools`, which owns the four-tier gate", () => {
    expect(META_TOOL_OWNERS.find_tools).toBe("tools");
    expect(META_TOOL_OWNERS.execute_tools).toBe("tools");
  });

  it("does NOT claim the two delegation tools, because those stay in this context", () => {
    expect(META_TOOL_OWNERS.spawn_agent).toBeUndefined();
    expect(META_TOOL_OWNERS.delegate_to_sub_agent).toBeUndefined();
  });
});
