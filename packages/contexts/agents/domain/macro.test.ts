import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type ActorId, type MacroId } from "./identifiers.js";
import {
  admitMacro,
  applyMacroPatch,
  byMacroOrder,
  macroAccessFor,
  macroIsEditableBy,
  readTemplatePath,
  resolveStep,
  resolveSteps,
  substitutePlaceholders,
  type Macro,
} from "./macro.js";
import { DEFAULT_AGENTS_POLICY } from "./policy.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const OTHER = asIdentifier<EnvironmentId>("env-2");
const OWNER = asAgentsIdentifier<ActorId>("operator-1");
const STRANGER = asAgentsIdentifier<ActorId>("operator-2");
const POLICY = DEFAULT_AGENTS_POLICY.macros;
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    macroId: asAgentsIdentifier<MacroId>("macro-1"),
    environmentId: ENVIRONMENT,
    name: "Weekly digest",
    description: null,
    steps: [{ tool: "mail.send", params: {} }],
    paramSchema: null,
    sharedWithOrganization: false,
    createdBy: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("the visibility gate", () => {
  it("shows an owner their own macro", () => {
    expect(macroAccessFor(macro(), ENVIRONMENT, OWNER)).toBe("owner");
  });

  it("hides an unshared macro from everyone else", () => {
    expect(macroAccessFor(macro(), ENVIRONMENT, STRANGER)).toBeNull();
  });

  it("shows a shared macro to anyone in the scope", () => {
    expect(macroAccessFor(macro({ sharedWithOrganization: true }), ENVIRONMENT, STRANGER)).toBe("shared");
  });

  it("shows a shared macro to an UNATTRIBUTED caller", () => {
    expect(macroAccessFor(macro({ sharedWithOrganization: true }), ENVIRONMENT, null)).toBe("shared");
  });

  it("HIDES A MACRO IN ANOTHER ENVIRONMENT EVEN FROM ITS OWN AUTHOR", () => {
    // The scope is the containment boundary; authorship is not.
    expect(macroAccessFor(macro(), OTHER, OWNER)).toBeNull();
    expect(macroAccessFor(macro({ sharedWithOrganization: true }), OTHER, OWNER)).toBeNull();
  });
});

describe("the mutation gate", () => {
  it("lets the owner change it", () => {
    expect(macroIsEditableBy(macro(), ENVIRONMENT, OWNER)).toBe(true);
  });

  it("REFUSES a shared reader, who can legitimately see it", () => {
    const shared = macro({ sharedWithOrganization: true });
    expect(macroAccessFor(shared, ENVIRONMENT, STRANGER)).toBe("shared");
    expect(macroIsEditableBy(shared, ENVIRONMENT, STRANGER)).toBe(false);
  });

  it("refuses an unattributed caller even on a shared macro", () => {
    expect(macroIsEditableBy(macro({ sharedWithOrganization: true }), ENVIRONMENT, null)).toBe(false);
  });

  it("refuses across environments", () => {
    expect(macroIsEditableBy(macro(), OTHER, OWNER)).toBe(false);
  });
});

describe("admission", () => {
  it("trims the name and reads a blank description as none", () => {
    const admitted = admitMacro({ name: "  Digest  ", description: " ", steps: [] }, POLICY);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.name).toBe("Digest");
    expect(admitted.value.description).toBeNull();
  });

  it("refuses a blank name and one past the ceiling", () => {
    expect(admitMacro({ name: "  ", steps: [] }, POLICY).ok).toBe(false);
    expect(admitMacro({ name: "a".repeat(POLICY.maxNameLength + 1), steps: [] }, POLICY).ok).toBe(false);
  });

  it("refuses a recording past the step ceiling", () => {
    const steps = Array.from({ length: POLICY.maxSteps + 1 }, () => ({ tool: "t", params: {} }));
    const admitted = admitMacro({ name: "x", steps }, POLICY);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.fields[0]?.field).toBe("steps");
  });

  it("refuses a step that names no tool, pointing at its index", () => {
    const admitted = admitMacro({ name: "x", steps: [{ tool: "  ", params: {} }] }, POLICY);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.fields[0]?.field).toBe("steps[0].tool");
  });

  it("admits an empty recording", () => {
    expect(admitMacro({ name: "x", steps: [] }, POLICY).ok).toBe(true);
  });
});

describe("patching", () => {
  it("leaves a field the patch does not carry", () => {
    const patched = applyMacroPatch(macro({ description: "kept" }), { name: "Renamed" }, LATER);
    expect(patched.name).toBe("Renamed");
    expect(patched.description).toBe("kept");
    expect(patched.updatedAt).toEqual(LATER);
  });

  it("clears a description and a param schema on an explicit null", () => {
    const patched = applyMacroPatch(
      macro({ description: "x", paramSchema: { type: "object" } }),
      { description: null, paramSchema: null },
      LATER,
    );
    expect(patched.description).toBeNull();
    expect(patched.paramSchema).toBeNull();
  });

  it("toggles the shared flag", () => {
    expect(applyMacroPatch(macro(), { sharedWithOrganization: true }, LATER).sharedWithOrganization).toBe(true);
  });
});

describe("ordering", () => {
  it("puts the most recently updated first, then breaks a tie on id descending", () => {
    const stale = macro({ macroId: asAgentsIdentifier<MacroId>("a"), updatedAt: NOW });
    const fresh = macro({ macroId: asAgentsIdentifier<MacroId>("b"), updatedAt: LATER });
    expect([stale, fresh].sort(byMacroOrder)[0]).toBe(fresh);
    const tied = macro({ macroId: asAgentsIdentifier<MacroId>("c") });
    expect([stale, tied].sort(byMacroOrder).map((held) => held.macroId)).toEqual(["c", "a"]);
    expect(byMacroOrder(stale, stale)).toBe(0);
  });
});

describe("reading a template path", () => {
  it("prefers a FLAT key over a nested walk", () => {
    expect(readTemplatePath({ "user.name": "flat", user: { name: "nested" } }, "user.name")).toBe("flat");
  });

  it("walks a nested object when there is no flat key", () => {
    expect(readTemplatePath({ user: { name: "nested" } }, "user.name")).toBe("nested");
  });

  it("indexes an array on a numeric segment", () => {
    expect(readTemplatePath({ items: ["a", "b"] }, "items.1")).toBe("b");
  });

  it("answers undefined for a non-numeric segment on an array", () => {
    expect(readTemplatePath({ items: ["a"] }, "items.name")).toBeUndefined();
  });

  it("answers undefined for a negative index", () => {
    expect(readTemplatePath({ items: ["a"] }, "items.-1")).toBeUndefined();
  });

  it("answers undefined for a missing path, an empty key or a null context", () => {
    expect(readTemplatePath({}, "a.b")).toBeUndefined();
    expect(readTemplatePath({ a: 1 }, "")).toBeUndefined();
    expect(readTemplatePath(null, "a")).toBeUndefined();
  });

  it("stops walking through a scalar rather than reading a property off it", () => {
    expect(readTemplatePath({ a: "text" }, "a.length")).toBeUndefined();
  });
});

describe("substitution", () => {
  it("replaces a placeholder anywhere in a string", () => {
    expect(substitutePlaceholders("to ${user.email} now", { user: { email: "x@y" } })).toBe("to x@y now");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(substitutePlaceholders("${  user.email }", { user: { email: "x@y" } })).toBe("x@y");
  });

  it("FAILS OPEN: a missing path leaves its placeholder in place", () => {
    // A blank where a path was produces a request that runs and does the wrong
    // thing; a literal placeholder produces one that fails visibly.
    expect(substitutePlaceholders("to ${user.email}", {})).toBe("to ${user.email}");
  });

  it("coerces a non-string value to its string form", () => {
    expect(substitutePlaceholders("n=${count}", { count: 7 })).toBe("n=7");
  });

  it("walks nested objects and arrays", () => {
    expect(substitutePlaceholders({ to: ["${a}", { deep: "${a}" }] }, { a: "x" })).toEqual({
      to: ["x", { deep: "x" }],
    });
  });

  it("leaves non-string leaves alone", () => {
    expect(substitutePlaceholders({ n: 7, b: true, z: null }, {})).toEqual({ n: 7, b: true, z: null });
  });

  it("does not substitute into a KEY", () => {
    expect(substitutePlaceholders({ "${a}": "v" }, { a: "x" })).toEqual({ "${a}": "v" });
  });

  it("resolves one step and every step of a macro, in recorded order", () => {
    const held = macro({
      steps: [
        { tool: "mail.send", params: { to: "${user.email}" } },
        { tool: "calendar.add", params: { title: "${title}" } },
      ],
    });
    expect(resolveStep(held.steps[0]!, { user: { email: "x@y" } }).params).toEqual({ to: "x@y" });
    const resolved = resolveSteps(held, { user: { email: "x@y" }, title: "Sync" });
    expect(resolved.map((step) => step.tool)).toEqual(["mail.send", "calendar.add"]);
    expect(resolved[1]?.params).toEqual({ title: "Sync" });
  });
});
