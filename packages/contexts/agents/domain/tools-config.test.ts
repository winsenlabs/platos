import { describe, expect, it } from "vitest";

import {
  FALLBACK_DISPLAY_MODE,
  FALLBACK_TOOL_CALL_MODE,
  isToolCallMode,
  isToolDisplayMode,
  LEGACY_TOOL_CALL_MODE,
  normalizeToolCallMode,
  normalizeToolsBlockConfig,
  readToolsBlockConfig,
  resolveDisplayMode,
  TOOL_CALL_MODES,
  TOOL_DISPLAY_MODES,
} from "./tools-config.js";

describe("the mode vocabulary", () => {
  it("recognises every legal mode and nothing else", () => {
    for (const mode of TOOL_CALL_MODES) expect(isToolCallMode(mode)).toBe(true);
    expect(isToolCallMode(LEGACY_TOOL_CALL_MODE)).toBe(false);
    expect(isToolCallMode(undefined)).toBe(false);
  });

  it("recognises every legal display mode and nothing else", () => {
    for (const mode of TOOL_DISPLAY_MODES) expect(isToolDisplayMode(mode)).toBe(true);
    expect(isToolDisplayMode("tool-wrapper")).toBe(false);
  });
});

describe("mode coercion", () => {
  it("leaves a legal mode alone", () => {
    expect(normalizeToolCallMode("sub-agent")).toBe("sub-agent");
  });

  it("maps the legacy wizard value to the mode it plainly meant", () => {
    expect(normalizeToolCallMode(LEGACY_TOOL_CALL_MODE)).toBe("execute-tool");
  });

  it("falls back for anything else, including a non-string", () => {
    expect(normalizeToolCallMode("nonsense")).toBe(FALLBACK_TOOL_CALL_MODE);
    expect(normalizeToolCallMode(7)).toBe(FALLBACK_TOOL_CALL_MODE);
    expect(normalizeToolCallMode(null)).toBe(FALLBACK_TOOL_CALL_MODE);
  });
});

describe("normalizing a patch", () => {
  it("coerces an illegal mode the patch DOES carry", () => {
    expect(normalizeToolsBlockConfig({ mode: LEGACY_TOOL_CALL_MODE })).toEqual({ mode: "execute-tool" });
  });

  it("returns the SAME object when the mode is already legal, allocating nothing", () => {
    const config = { mode: "sub-agent" as const };
    expect(normalizeToolsBlockConfig(config)).toBe(config);
  });

  it("LEAVES A PATCH WITH NO MODE KEY UNTOUCHED", () => {
    // The control. Injecting a default here would, after the update path's
    // shallow merge, overwrite a stored `sub-agent` with `direct` on every
    // partial save — the exact bug the coercion exists to fix, one layer down.
    const patch = { displayMode: "summary" as const };
    const normalized = normalizeToolsBlockConfig(patch);
    expect(normalized).toBe(patch);
    expect(normalized).not.toHaveProperty("mode");
  });

  it("carries an explicit undefined mode through the coercion, since the key IS present", () => {
    expect(normalizeToolsBlockConfig({ mode: undefined })).toEqual({ mode: FALLBACK_TOOL_CALL_MODE });
  });

  it("passes a non-object through unchanged", () => {
    expect(normalizeToolsBlockConfig(null)).toBeNull();
    expect(normalizeToolsBlockConfig([1])).toEqual([1]);
    expect(normalizeToolsBlockConfig("x")).toBe("x");
  });

  it("does not mutate the patch it was given", () => {
    const patch = { mode: LEGACY_TOOL_CALL_MODE, displayMode: "full" };
    normalizeToolsBlockConfig(patch);
    expect(patch.mode).toBe(LEGACY_TOOL_CALL_MODE);
  });
});

describe("display mode", () => {
  it("falls back for an absent or unknown value, so legacy rows keep their behaviour", () => {
    expect(resolveDisplayMode(null)).toBe(FALLBACK_DISPLAY_MODE);
    expect(resolveDisplayMode({})).toBe(FALLBACK_DISPLAY_MODE);
    expect(resolveDisplayMode({ displayMode: "nonsense" as never })).toBe(FALLBACK_DISPLAY_MODE);
  });

  it("honours a legal value", () => {
    expect(resolveDisplayMode({ displayMode: "hybrid" })).toBe("hybrid");
  });
});

describe("reading a stored column", () => {
  it("answers null for anything that is not an object", () => {
    expect(readToolsBlockConfig(null)).toBeNull();
    expect(readToolsBlockConfig([1])).toBeNull();
    expect(readToolsBlockConfig("x")).toBeNull();
  });

  it("answers null for an object with no keys", () => {
    expect(readToolsBlockConfig({})).toBeNull();
  });

  it("coerces a stored illegal mode on the way out", () => {
    expect(readToolsBlockConfig({ mode: LEGACY_TOOL_CALL_MODE })?.mode).toBe("execute-tool");
  });

  it("keeps every other key, including the three-state category filter", () => {
    const read = readToolsBlockConfig({ enabledCategories: [], pinnedTools: ["mail.send"] });
    expect(read?.enabledCategories).toEqual([]);
    expect(read?.pinnedTools).toEqual(["mail.send"]);
  });

  it("keeps an explicitly false entity mandate distinct from an absent one", () => {
    expect(readToolsBlockConfig({ entityIdsRequired: false })?.entityIdsRequired).toBe(false);
    expect(readToolsBlockConfig({ displayMode: "full" })?.entityIdsRequired).toBeUndefined();
  });
});
