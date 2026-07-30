import { describe, it, expect } from "vitest";
import { repairStringifiedToolInput, type RepairSchema } from "./tool-input-repair";

/** The real `execute_tools` shape: { calls: [{ tool, params }] }. */
const EXECUTE_TOOLS_SCHEMA: RepairSchema = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string" },
          params: { type: "object" },
        },
      },
    },
  },
};

describe("repairStringifiedToolInput — the production regression", () => {
  it("repairs `calls` emitted as a JSON string with multi-line body content", () => {
    // EXACTLY the shape from trace 0adb2b4070f540634d5f610f3f1bbca0: the inner
    // array arrives as a string, and the email body carries real newlines.
    const inner = JSON.stringify([
      {
        tool: "GMAIL_SEND_EMAIL",
        params: { recipient_email: "sam@acme.com", body: "Hi Sam,\n\nThanks for the call.\n\nTejas" },
      },
    ]);
    const raw = JSON.stringify({ calls: inner });

    const repaired = repairStringifiedToolInput(raw, EXECUTE_TOOLS_SCHEMA);
    expect(repaired).not.toBeNull();

    const out = JSON.parse(repaired!);
    expect(Array.isArray(out.calls)).toBe(true);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].tool).toBe("GMAIL_SEND_EMAIL");
    // Newlines survive the round-trip intact.
    expect(out.calls[0].params.body).toBe("Hi Sam,\n\nThanks for the call.\n\nTejas");
  });

  it("repairs a doubly-nested case: stringified calls AND stringified params", () => {
    const raw = JSON.stringify({
      calls: JSON.stringify([
        { tool: "LINEAR_CREATE_ISSUE", params: JSON.stringify({ title: "Bug", description: "a\nb" }) },
      ]),
    });
    const out = JSON.parse(repairStringifiedToolInput(raw, EXECUTE_TOOLS_SCHEMA)!);
    expect(Array.isArray(out.calls)).toBe(true);
    expect(out.calls[0].params).toEqual({ title: "Bug", description: "a\nb" });
  });

  it("accepts an already-parsed object input", () => {
    const out = JSON.parse(
      repairStringifiedToolInput({ calls: '[{"tool":"X","params":{}}]' }, EXECUTE_TOOLS_SCHEMA)!,
    );
    expect(out.calls[0].tool).toBe("X");
  });
});

describe("repairStringifiedToolInput — safety (must NOT corrupt real arguments)", () => {
  it("leaves a well-formed call untouched (returns null = nothing to repair)", () => {
    const raw = JSON.stringify({ calls: [{ tool: "X", params: { a: 1 } }] });
    expect(repairStringifiedToolInput(raw, EXECUTE_TOOLS_SCHEMA)).toBeNull();
  });

  it("does NOT unwrap a STRING property that merely looks like JSON", () => {
    // The dangerous case: a body/snippet that legitimately starts with '{'.
    const schema: RepairSchema = {
      type: "object",
      properties: { body: { type: "string" }, subject: { type: "string" } },
    };
    const raw = JSON.stringify({
      body: '{"looks": "like json but is the actual email text"}',
      subject: "[URGENT] release",
    });
    // Schema says both are strings -> no repair, so null.
    expect(repairStringifiedToolInput(raw, schema)).toBeNull();
  });

  it("does nothing without a schema (never guesses)", () => {
    const raw = JSON.stringify({ calls: '[{"tool":"X"}]' });
    expect(repairStringifiedToolInput(raw, undefined)).toBeNull();
  });

  it("leaves genuinely malformed JSON alone so the SDK error stands", () => {
    const raw = JSON.stringify({ calls: "[{unclosed" });
    expect(repairStringifiedToolInput(raw, EXECUTE_TOOLS_SCHEMA)).toBeNull();
  });

  it("does not unwrap when the string parses to a scalar", () => {
    const schema: RepairSchema = { type: "object", properties: { calls: { type: "array" } } };
    expect(repairStringifiedToolInput(JSON.stringify({ calls: "42" }), schema)).toBeNull();
  });

  it("does not treat an object-string as an array (shape must match the schema)", () => {
    const schema: RepairSchema = { type: "object", properties: { calls: { type: "array" } } };
    // '{...}' parses to an object but the schema wants an array -> no repair.
    expect(repairStringifiedToolInput(JSON.stringify({ calls: '{"a":1}' }), schema)).toBeNull();
  });

  it("returns null for a broken outer envelope", () => {
    expect(repairStringifiedToolInput("{not json", EXECUTE_TOOLS_SCHEMA)).toBeNull();
  });

  it("handles schemas that omit `type` but declare properties/items", () => {
    const schema: RepairSchema = { properties: { calls: { items: { properties: {} } } } };
    const out = repairStringifiedToolInput(JSON.stringify({ calls: '[{"tool":"X"}]' }), schema);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).calls[0].tool).toBe("X");
  });
});
