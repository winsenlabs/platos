import { describe, it, expect } from "vitest";
import {
  describeToolCount,
  renderCategorySummaryBlock,
} from "./prompt-builder.service";

/**
 * PROMPT-CACHE (audit finding 7) — the "## Available tool categories" block is
 * spliced into the system prompt, so anything volatile in it invalidates the
 * whole Anthropic cache prefix (tools + system + every cached message).
 *
 * The volatile thing was an exact per-category tool count, which moves for
 * reasons unrelated to the agent: an MCP server publishing a tool, an entity
 * re-discovering, the ~5-minute discovery cron.
 */

describe("describeToolCount", () => {
  it("keeps exact wording at the low end where it is still meaningful", () => {
    expect(describeToolCount(0)).toBe("0 tool");
    expect(describeToolCount(1)).toBe("1 tool");
  });

  it("buckets everything above that", () => {
    expect(describeToolCount(2)).toBe("a few tools");
    expect(describeToolCount(5)).toBe("a few tools");
    expect(describeToolCount(6)).toBe("several tools");
    expect(describeToolCount(20)).toBe("several tools");
    expect(describeToolCount(21)).toBe("many tools");
    expect(describeToolCount(400)).toBe("many tools");
  });

  it("is stable across the registry drift that actually happens", () => {
    // A real registry wobbling by a tool or two must not change a single byte.
    expect(describeToolCount(47)).toBe(describeToolCount(48));
    expect(describeToolCount(47)).toBe(describeToolCount(40));
    expect(describeToolCount(47)).toBe(describeToolCount(400));
  });

  it("tolerates junk without throwing (fail-open, like the rest of the block)", () => {
    expect(describeToolCount(-5)).toBe("0 tool");
    expect(describeToolCount(NaN)).toBe("0 tool");
    expect(describeToolCount(3.7)).toBe("a few tools");
  });
});

describe("renderCategorySummaryBlock — cache stability", () => {
  /**
   * THE REGRESSION. Discovery adds one tool to a category between two turns.
   * Before bucketing this rewrote the system prompt and forced a full-price
   * prefix write on the next turn.
   */
  it("survives a category gaining a tool", () => {
    const before = renderCategorySummaryBlock([
      { id: "entity", count: 47 },
      { id: "utility", count: 8 },
    ]);
    const after = renderCategorySummaryBlock([
      { id: "entity", count: 48 },
      { id: "utility", count: 8 },
    ]);
    expect(after).toBe(before);
    // And no bare integer leaked back into the block.
    expect(before).not.toMatch(/\(4[78] tools\)/);
  });

  it("still names every category and its description", () => {
    const out = renderCategorySummaryBlock(
      [{ id: "entity", count: 47 }],
      { entity: { description: "connected app tools" } },
    );
    expect(out).toContain("## Available tool categories");
    expect(out).toContain("**entity**");
    expect(out).toContain("connected app tools");
    expect(out).toContain("many tools");
  });

  it("returns empty for no categories rather than a dangling header", () => {
    expect(renderCategorySummaryBlock([])).toBe("");
  });

  it("a genuine order-of-magnitude change DOES still show through", () => {
    // Bucketing must not flatten the signal entirely — 3 tools and 300 tools
    // should read differently to the model.
    const small = renderCategorySummaryBlock([{ id: "entity", count: 3 }]);
    const large = renderCategorySummaryBlock([{ id: "entity", count: 300 }]);
    expect(small).not.toBe(large);
  });
});
