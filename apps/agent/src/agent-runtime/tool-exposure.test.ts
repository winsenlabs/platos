import { describe, it, expect } from "vitest";
import {
  resolveToolExposure,
  isMetaTool,
  selectDirectTools,
  normaliseParamSchema,
  directModeSystemNote,
  META_TOOL_NAMES,
} from "./tool-exposure";

describe("resolveToolExposure — opt-in, never a surprise", () => {
  it("defaults to meta so untouched agents keep working", () => {
    // Every existing agent has no `toolExposure` key. If this defaulted to
    // "direct" their find_tools/execute_tools would vanish on deploy.
    expect(resolveToolExposure(undefined)).toBe("meta");
    expect(resolveToolExposure(null)).toBe("meta");
    expect(resolveToolExposure({})).toBe("meta");
    expect(resolveToolExposure({ mode: "direct" })).toBe("meta"); // `mode` is NOT exposure
  });

  it("only the exact string 'direct' opts in", () => {
    expect(resolveToolExposure({ toolExposure: "direct" })).toBe("direct");
    expect(resolveToolExposure({ toolExposure: "meta" })).toBe("meta");
    for (const junk of ["Direct", "DIRECT", true, 1, {}, [], "full"]) {
      expect(resolveToolExposure({ toolExposure: junk })).toBe("meta");
    }
  });

  it("is not confused by mode or displayMode sitting alongside it", () => {
    // The three fields coexist; only toolExposure decides callability.
    expect(
      resolveToolExposure({ mode: "sub-agent", displayMode: "meta-tool", toolExposure: "direct" }),
    ).toBe("direct");
  });
});

describe("meta vs context tools", () => {
  it("ONLY find_tools and execute_tools are meta-tools", () => {
    expect(META_TOOL_NAMES).toEqual(["find_tools", "execute_tools"]);
    expect(isMetaTool("find_tools")).toBe(true);
    expect(isMetaTool("execute_tools")).toBe(true);
  });

  it("context tools are not meta-tools and must survive direct mode", () => {
    // This is the distinction that was previously blurred — "execute-tool mode"
    // once stripped an agent's memory as a side effect of that confusion.
    for (const t of [
      "remember", "recall", "forget", "list_memories", "relate", "memory_extract",
      "update_user_profile", "recall_user_profile",
      "artifact_create", "artifact_publish", "schedule_create", "request_approval",
    ]) {
      expect(isMetaTool(t)).toBe(false);
    }
  });
});

describe("selectDirectTools — cache-safe ordering", () => {
  const t = (toolName: string) => ({ toolName, description: "d", paramSchema: {} });

  it("sorts by name, because these schemas sit in the cache prefix", () => {
    // The tools block precedes the system prompt in Anthropic's prefix, so a
    // reordering invalidates tools + system + every cached message behind it.
    const out = selectDirectTools([t("zebra"), t("alpha"), t("mango")]);
    expect(out.map((x) => x.toolName)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("produces identical output regardless of registry iteration order", () => {
    const a = selectDirectTools([t("b"), t("a"), t("c")]);
    const b = selectDirectTools([t("c"), t("b"), t("a")]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("de-duplicates by name — two entities can publish the same tool", () => {
    const out = selectDirectTools([
      { toolName: "dup", description: "first", paramSchema: {} },
      { toolName: "dup", description: "second", paramSchema: {} },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("first"); // first wins, deterministically
  });

  it("skips entries with no name rather than emitting an empty key", () => {
    expect(selectDirectTools([{ toolName: "", description: "d", paramSchema: {} }, t("ok")]))
      .toHaveLength(1);
  });

  it("handles an empty registry", () => {
    expect(selectDirectTools([])).toEqual([]);
  });
});

describe("normaliseParamSchema — one bad entity must not kill the turn", () => {
  it("coerces junk into a valid object schema", () => {
    // Entity schemas are arbitrary JSON from an external service. The AI SDK
    // throws on a non-object schema at registration time, which would take down
    // EVERY agent that can see that entity — not just the one tool.
    for (const bad of [null, undefined, "string", 42, [], true]) {
      expect(normaliseParamSchema(bad)).toEqual({ type: "object", properties: {} });
    }
  });

  it("repairs a schema missing type or properties", () => {
    expect(normaliseParamSchema({ properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(normaliseParamSchema({ type: "string" })).toEqual({ type: "object", properties: {} });
  });

  it("preserves a well-formed schema, including required and extras", () => {
    const good = {
      type: "object",
      properties: { channel: { type: "string" }, text: { type: "string" } },
      required: ["channel", "text"],
    };
    expect(normaliseParamSchema(good)).toEqual(good);
  });

  it("does not mutate its input", () => {
    const input = { type: "string" };
    const snapshot = JSON.stringify(input);
    normaliseParamSchema(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("directModeSystemNote — must be cache-stable", () => {
  it("is byte-identical across calls", () => {
    // It lands in the cached prefix. A previous block embedded live tool counts
    // there and invalidated the cache whenever an integration published a tool.
    expect(directModeSystemNote()).toBe(directModeSystemNote());
  });

  it("carries no counts, names, timestamps or ids", () => {
    const note = directModeSystemNote();
    expect(note).not.toMatch(/\d/);
    expect(note).toContain("call them directly by name");
  });
});
