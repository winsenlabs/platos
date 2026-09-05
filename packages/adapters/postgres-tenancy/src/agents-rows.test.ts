// The two readers that can REFUSE, and the one that cannot.
//
// `agents-rows.ts` is mostly field copying, and field copying is not worth a
// suite. What is worth one is the pair of readers that throw rather than
// inventing a value, because the alternative each of them declines is the kind
// that ships: a `toolDefaultPolicy` the domain does not name would default to
// `NONE` and silently expose no tools where a version said `ALL`, and a macro
// step with no tool would replay as a no-op that reports success.
//
// NEITHER CAN BE REACHED THROUGH POSTGRESQL TODAY, and that is why they are
// here rather than in an integration suite. `AgentVersion.toolDefaultPolicy` is
// a database ENUM, so the column cannot hold a value outside the set until a
// migration adds one; `Macro_steps_json_root` pins the column to an ARRAY and
// says nothing about what is inside it, so a malformed STEP is reachable in
// principle and only by a writer that is not this adapter. A guard nothing can
// turn red is a guard that is not there, so both are falsified here.

import { describe, expect, test } from "vitest";

import { DEFAULT_AGENTS_POLICY } from "@platos/context-agents/application/ports/index.js";

import {
  toMacroSteps,
  toVersion,
  UNREADABLE_AGENTS_ROW,
  UnreadableAgentsRowError,
  type AgentVersionRowShape,
} from "./agents-rows.js";

const AT = new Date("2026-05-01T09:00:00.000Z");
const DEFAULTS = DEFAULT_AGENTS_POLICY.defaults;

function versionRow(overrides: Partial<AgentVersionRowShape> = {}): AgentVersionRowShape {
  return {
    id: "aa000000-0000-4000-8000-000000000001",
    agentId: "aa000000-0000-4000-8000-000000000002",
    versionNumber: 1,
    model: "openai:gpt-4o",
    systemPrompt: null,
    maxSteps: 10,
    contextLimit: 128_000,
    toolDefaultPolicy: "NONE",
    promptBlocks: [],
    dynamicBlocks: [],
    toolsBlockConfig: {},
    modelRoutes: [],
    memoryConfig: {},
    outputSchema: null,
    note: null,
    createdBy: "operator-1",
    createdAt: AT,
    ...overrides,
  };
}

describe("toVersion", () => {
  test("reads both tool default policies the domain names", () => {
    expect(toVersion(versionRow(), DEFAULTS).toolDefaultPolicy).toBe("NONE");
    expect(toVersion(versionRow({ toolDefaultPolicy: "ALL" }), DEFAULTS).toolDefaultPolicy).toBe("ALL");
  });

  test("REFUSES a tool default policy the domain does not name", () => {
    expect(() => toVersion(versionRow({ toolDefaultPolicy: "SOME" }), DEFAULTS)).toThrow(
      UnreadableAgentsRowError,
    );
    try {
      toVersion(versionRow({ toolDefaultPolicy: "SOME" }), DEFAULTS);
    } catch (error) {
      expect((error as UnreadableAgentsRowError).code).toBe(UNREADABLE_AGENTS_ROW);
      expect((error as UnreadableAgentsRowError).column).toBe("AgentVersion.toolDefaultPolicy");
    }
  });

  test("reads a version through the domain's own envelope, not around it", () => {
    const carried = toVersion(
      versionRow({
        memoryConfig: { keep: 1, __runtime: { historyMode: "full", enabledTools: ["alpha"] } },
      }),
      DEFAULTS,
    );
    // The operator's own memory configuration comes back WITHOUT the envelope,
    // and the carried tool list comes back INSIDE the projected tools config.
    expect(carried.snapshot.memoryConfig).toEqual({ keep: 1 });
    expect(carried.snapshot.historyMode).toBe("full");
    expect(carried.snapshot.toolsBlockConfig).toMatchObject({ enabledTools: ["alpha"] });
  });
});

describe("toMacroSteps", () => {
  test("reads the steps a macro carries", () => {
    expect(toMacroSteps("m", [{ tool: "send", params: { to: "x" } }])).toEqual([
      { tool: "send", params: { to: "x" } },
    ]);
  });

  test("a step with no params reads as an empty object, not as null", () => {
    expect(toMacroSteps("m", [{ tool: "send" }])).toEqual([{ tool: "send", params: {} }]);
  });

  test("REFUSES a steps column that is not an array", () => {
    expect(() => toMacroSteps("m", {})).toThrow(UnreadableAgentsRowError);
  });

  test("REFUSES a step that names no tool", () => {
    expect(() => toMacroSteps("m", [{ params: {} }])).toThrow(/step 0 names no tool/u);
    expect(() => toMacroSteps("m", [{ tool: "" }])).toThrow(/step 0 names no tool/u);
    expect(() => toMacroSteps("m", [null])).toThrow(/step 0 names no tool/u);
  });
});
