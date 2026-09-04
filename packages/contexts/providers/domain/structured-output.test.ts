import { describe, expect, it } from "vitest";

import { promptMessage, textPart } from "./prompt.js";
import {
  MAX_CORRECTION_ERRORS,
  MAX_CORRECTION_RAW_TEXT,
  NO_PARSEABLE_OUTPUT,
  structuredOutputCorrection,
  structuredOutputCorrectionText,
} from "./structured-output.js";

const ERRORS = ["/name: must be string", "/age: must be integer"];

describe("structuredOutputCorrectionText", () => {
  it("numbers the errors from one and quotes the prior output", () => {
    const text = structuredOutputCorrectionText('{"name":1}', ERRORS);

    expect(text).toContain("1. /name: must be string");
    expect(text).toContain("2. /age: must be integer");
    expect(text).toContain('<prior>\n{"name":1}\n</prior>');
  });

  it("names exactly ten errors and drops the eleventh", () => {
    const many = Array.from({ length: 25 }, (_unused, index) => `error-${index}`);

    const text = structuredOutputCorrectionText(null, many);

    expect(text).toContain("10. error-9");
    expect(text).not.toContain("11. error-10");
    expect(text).not.toContain("error-24");
  });

  it("caps the quoted prior output at four thousand characters", () => {
    const huge = "x".repeat(MAX_CORRECTION_RAW_TEXT * 3);

    const text = structuredOutputCorrectionText(huge, ERRORS);

    const quoted = text.slice(text.indexOf("<prior>\n") + "<prior>\n".length, text.indexOf("\n</prior>"));
    expect(quoted).toHaveLength(MAX_CORRECTION_RAW_TEXT);
  });

  it("stays bounded even when both inputs are unbounded", () => {
    // The property the two caps exist for, stated as one number: an arbitrarily
    // large rejected payload cannot produce an arbitrarily large correction.
    const many = Array.from({ length: 5_000 }, () => "y".repeat(500));

    const text = structuredOutputCorrectionText("z".repeat(1_000_000), many);

    // 10 errors x (500 + numbering) + 4000 quoted + the fixed frame.
    expect(text.length).toBeLessThan(10_000);
  });

  it("says the output was unparseable rather than quoting nothing", () => {
    expect(structuredOutputCorrectionText(null, ERRORS)).toContain(NO_PARSEABLE_OUTPUT);
    expect(structuredOutputCorrectionText("", ERRORS)).toContain(NO_PARSEABLE_OUTPUT);
  });

  it("pins the cap constants themselves", () => {
    expect(MAX_CORRECTION_ERRORS).toBe(10);
    expect(MAX_CORRECTION_RAW_TEXT).toBe(4000);
  });
});

describe("structuredOutputCorrection", () => {
  it("builds a user message carrying exactly one text part", () => {
    const message = structuredOutputCorrection('{"name":1}', ERRORS);

    expect(message.role).toBe("user");
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toEqual(textPart(structuredOutputCorrectionText('{"name":1}', ERRORS)));
  });

  it("carries no cache breakpoint, because placement reassigns every one", () => {
    expect(structuredOutputCorrection(null, ERRORS).cacheBreakpoint).toBe(false);
  });

  it("is what `promptMessage` would have built, so the two cannot drift", () => {
    const direct = structuredOutputCorrection("raw", ERRORS);
    const guarded = promptMessage({ role: "user", content: direct.content });

    expect(guarded.ok).toBe(true);
    if (!guarded.ok) throw new Error("unreachable");
    expect(guarded.value).toEqual(direct);
  });
});
