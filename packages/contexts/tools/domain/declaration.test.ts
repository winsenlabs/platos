import { describe, expect, it } from "vitest";

import {
  admitDeclaration,
  declaredNames,
  registrationOutcome,
  type ToolDeclarationIntake,
} from "./declaration.js";
import { asToolsIdentifier, type ExternalEntityId, type ToolName } from "./identifiers.js";
import { MAX_TOOL_NAME_LENGTH } from "./tool.js";

const ENTITY = asToolsIdentifier<ExternalEntityId>("acme-backend");

function name(value: string): ToolName {
  return asToolsIdentifier<ToolName>(value);
}

describe("admitting a declaration", () => {
  it("comes back sorted, whatever order the backend sent", () => {
    const admitted = admitDeclaration(
      [{ name: "zeta" }, { name: "alpha" }, { name: "mid" }],
      ENTITY,
    );
    expect(admitted.ok && admitted.value.map((tool) => tool.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("trims before it judges, so a padded name is the same name", () => {
    const admitted = admitDeclaration([{ name: "  files.upload  " }], ENTITY);
    expect(admitted.ok && admitted.value[0]?.name).toBe("files.upload");
  });

  it("refuses the WHOLE declaration when one name is blank", () => {
    const admitted = admitDeclaration([{ name: "good" }, { name: "   " }], ENTITY);
    expect(admitted.ok).toBe(false);
    expect(!admitted.ok && admitted.error.code).toBe("TOOLS_DECLARATION_INVALID");
  });

  it("refuses a duplicate on the TRIMMED name, not the raw one", () => {
    const admitted = admitDeclaration([{ name: "search" }, { name: " search " }], ENTITY);
    expect(admitted.ok).toBe(false);
    expect(!admitted.ok && admitted.error.code).toBe("TOOLS_DUPLICATE_TOOL_NAME");
    expect(!admitted.ok && admitted.error.details["name"]).toBe("search");
  });

  it("does not put the caller-supplied name in the message a transport renders", () => {
    // The name reaches this context from an MCP client, so reflecting it into a
    // renderable message is the source's one reflection risk. It travels in
    // `details`, which the kernel documents as never returned to a client.
    const reflected = "<script>alert(1)</script>";
    const admitted = admitDeclaration([{ name: reflected }, { name: reflected }], ENTITY);
    expect(!admitted.ok && admitted.error.message).not.toContain(reflected);
    expect(!admitted.ok && admitted.error.details["name"]).toBe(reflected);
  });

  it("refuses a name past the ceiling", () => {
    const admitted = admitDeclaration([{ name: "x".repeat(MAX_TOOL_NAME_LENGTH + 1) }], ENTITY);
    expect(admitted.ok).toBe(false);
  });
});

describe("the three coercions, each a shape a live backend sends", () => {
  it("gives a tool with no briefing an empty description rather than refusing it", () => {
    const admitted = admitDeclaration([{ name: "t" }, { name: "u", description: 7 as never }], ENTITY);
    expect(admitted.ok && admitted.value.map((tool) => tool.description)).toEqual(["", ""]);
  });

  it("gives a zero-argument tool an empty schema", () => {
    const admitted = admitDeclaration([{ name: "t" }, { name: "u", paramSchema: null }], ENTITY);
    expect(admitted.ok && admitted.value.map((tool) => tool.paramSchema)).toEqual([{}, {}]);
  });

  it("does NOT let an array through as an object root", () => {
    const admitted = admitDeclaration([{ name: "t", paramSchema: [1, 2] }], ENTITY);
    expect(admitted.ok && admitted.value[0]?.paramSchema).toEqual({});
  });

  it("infers a category only when the author left one blank", () => {
    const admitted = admitDeclaration(
      [
        { name: "github.issue", category: "  " },
        { name: "search", category: "custom" },
      ],
      ENTITY,
    );
    expect(admitted.ok && admitted.value.map((tool) => tool.category)).toEqual([
      "github",
      "custom",
    ]);
  });
});

describe("what a registration reports", () => {
  const previousToolIds = new Set(["tool-a", "tool-b"]);

  it("counts a tool the entity never registered before as new", () => {
    const outcome = registrationOutcome({
      registeredToolIds: ["tool-a", "tool-c"],
      previousToolIds,
      previousNames: [name("a"), name("b")],
      declared: new Set([name("a"), name("c")]),
    });
    expect(outcome).toEqual({ registered: 2, updated: 1, newTools: 1, removed: 1 });
  });

  it("reports a re-registration of an unchanged set as all updated, none new", () => {
    const outcome = registrationOutcome({
      registeredToolIds: ["tool-a", "tool-b"],
      previousToolIds,
      previousNames: [name("a"), name("b")],
      declared: new Set([name("a"), name("b")]),
    });
    expect(outcome).toEqual({ registered: 2, updated: 2, newTools: 0, removed: 0 });
  });

  it("counts everything the declaration dropped as removed, which is what makes the registry shrink", () => {
    const outcome = registrationOutcome({
      registeredToolIds: [],
      previousToolIds,
      previousNames: [name("a"), name("b")],
      declared: new Set(),
    });
    expect(outcome.removed).toBe(2);
    expect(outcome.registered).toBe(0);
  });
});

describe("the declared name set", () => {
  it("is what a caller diffs the previous exposure against", () => {
    const admitted = admitDeclaration([{ name: "b" }, { name: "a" }] as ToolDeclarationIntake[], ENTITY);
    expect(admitted.ok && [...declaredNames(admitted.value)].sort()).toEqual(["a", "b"]);
  });
});
