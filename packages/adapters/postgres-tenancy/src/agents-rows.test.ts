// The readers that can REFUSE, and the ones that cannot.
//
// `agents-rows.ts` is mostly field copying, and field copying is not worth a
// suite. What is worth one is the set of readers that throw rather than
// inventing a value, because the alternative each of them declines is the kind
// that ships: a `toolDefaultPolicy` the domain does not name would default to
// `NONE` and silently expose no tools where a version said `ALL`, a macro step
// with no tool would replay as a no-op that reports success, and — WIN-258 T7 —
// a step whose `params` are not an object used to replay WITH NO PARAMETERS.
//
// ONLY THE MACRO ONES CAN BE REACHED THROUGH POSTGRESQL, and the split is the
// point. `AgentVersion.toolDefaultPolicy` is a database ENUM, so the column
// cannot hold a value outside the set until a migration adds one, and every
// object column's root is pinned by a `_json_root` CHECK. `Macro_steps_json_root`
// pins the column to an ARRAY and says NOTHING about what is inside it, so a
// malformed step — and a malformed `params` inside a well-formed step — is
// reachable by any writer, and `json-columns.integration.test.ts` reaches it
// with `prisma db execute`. A guard nothing can turn red is a guard that is not
// there, so all of them are falsified here and the reachable ones twice.

import { describe, expect, test } from "vitest";

import { DEFAULT_AGENTS_POLICY } from "@platos/context-agents/application/ports/index.js";

import {
  AGENTS_COLUMN_NOT_AN_OBJECT,
  MACRO_STEP_NAMES_NO_TOOL,
  MACRO_STEP_PARAMS_NOT_AN_OBJECT,
  MACRO_STEPS_NOT_AN_ARRAY,
  readObjectColumn,
  toMacroSteps,
  toVersion,
  UNREADABLE_AGENTS_ROW,
  UnreadableAgentsRowError,
  type AgentVersionRowShape,
} from "./agents-rows.js";

/** The code a refusal carried, or the string that says it did not refuse. */
function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof UnreadableAgentsRowError ? error.code : `not-a-row-refusal:${String(error)}`;
  }
  return "no-refusal";
}

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
    expect(codeOf(() => toMacroSteps("m", {}))).toBe(MACRO_STEPS_NOT_AN_ARRAY);
  });

  test("REFUSES a step that names no tool", () => {
    expect(() => toMacroSteps("m", [{ params: {} }])).toThrow(/step 0 names no tool/u);
    expect(() => toMacroSteps("m", [{ tool: "" }])).toThrow(/step 0 names no tool/u);
    expect(() => toMacroSteps("m", [null])).toThrow(/step 0 names no tool/u);
    expect(codeOf(() => toMacroSteps("m", [null]))).toBe(MACRO_STEP_NAMES_NO_TOOL);
  });

  // WIN-258 T7. This was a COERCION and not a refusal: params that were not an
  // object read back as `{}`, so the step replayed with no parameters at all and
  // the read reported success. Each of the three shapes below satisfies
  // `Macro_steps_json_root`, because that CHECK pins the ROOT of the column and
  // says nothing about an element's members.
  test("REFUSES a step whose params are present and are not an object", () => {
    expect(() => toMacroSteps("m", [{ tool: "send", params: ["a"] }])).toThrow(
      /step 0 carries a JSON array where params is an object/u,
    );
    expect(() => toMacroSteps("m", [{ tool: "send", params: "oops" }])).toThrow(
      /step 0 carries string where params is an object/u,
    );
    expect(codeOf(() => toMacroSteps("m", [{ tool: "send", params: 7 }]))).toBe(
      MACRO_STEP_PARAMS_NOT_AN_OBJECT,
    );
  });

  test("the four refusals this module raises carry four different codes", () => {
    const codes = [
      codeOf(() => toVersion(versionRow({ toolDefaultPolicy: "SOME" }), DEFAULTS)),
      codeOf(() => toMacroSteps("m", {})),
      codeOf(() => toMacroSteps("m", [null])),
      codeOf(() => toMacroSteps("m", [{ tool: "send", params: 7 }])),
    ];
    expect(new Set(codes).size).toBe(4);
  });
});

describe("readObjectColumn", () => {
  test("reads an object, and reads absence as absence", () => {
    expect(readObjectColumn("AgentCluster.metadata", "AgentCluster c", { a: 1 })).toEqual({ a: 1 });
    expect(readObjectColumn("AgentCluster.metadata", "AgentCluster c", null)).toBeNull();
    expect(readObjectColumn("AgentCluster.metadata", "AgentCluster c", undefined)).toBeNull();
  });

  test("REFUSES an array and a scalar rather than answering null", () => {
    expect(() => readObjectColumn("AgentSkill.config", "AgentSkill s", [])).toThrow(
      /carries a JSON array where AgentSkill.config is an object/u,
    );
    expect(codeOf(() => readObjectColumn("AgentSkill.config", "AgentSkill s", 3))).toBe(
      AGENTS_COLUMN_NOT_AN_OBJECT,
    );
  });
});
