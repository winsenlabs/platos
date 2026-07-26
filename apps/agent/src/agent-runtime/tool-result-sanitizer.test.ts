import { describe, it, expect } from "vitest";
import type { Tool } from "ai";
import { sanitizeToolResult, hardenToolResults } from "./tool-result-sanitizer";

/**
 * Regression cover for the AI_InvalidPromptError
 * ("The messages do not match the ModelMessage[] schema") that killed Walle
 * tool turns. The AI SDK embeds each tool `execute` return as a tool-result
 * part in the next step's ModelMessage[]; an `undefined` or non-serializable
 * return produced an invalid part. These tests pin the boundary that coerces
 * every return into a valid, JSON-round-trippable value.
 */

/** The load-bearing invariant: the result must survive a JSON round-trip
 *  unchanged (this is what the provider does to build the tool-result part). */
function assertJsonSafe(v: unknown): void {
  expect(() => JSON.stringify(v)).not.toThrow();
  expect(JSON.parse(JSON.stringify(v))).toEqual(v);
}

describe("sanitizeToolResult", () => {
  it("coerces undefined to { ok: false } (the core bug)", () => {
    const out = sanitizeToolResult(undefined);
    expect(out).toEqual({ ok: false });
    assertJsonSafe(out);
  });

  it("coerces top-level null to { ok: false }", () => {
    expect(sanitizeToolResult(null)).toEqual({ ok: false });
  });

  it("drops object fields that are undefined (the request_approval shape)", () => {
    const out = sanitizeToolResult({
      approved: false,
      comment: undefined,
      respondedBy: undefined,
    });
    expect(out).toEqual({ approved: false });
    expect(Object.prototype.hasOwnProperty.call(out, "comment")).toBe(false);
    assertJsonSafe(out);
  });

  it("preserves a well-formed nested object untouched", () => {
    const input = { results: [{ tool: "x", status: "success", latencyMs: 3 }] };
    const out = sanitizeToolResult(input);
    expect(out).toEqual(input);
    assertJsonSafe(out);
  });

  it("stringifies bigint (would otherwise throw in JSON.stringify)", () => {
    const out = sanitizeToolResult({ n: 10n, deep: { m: 2n } }) as any;
    expect(out).toEqual({ n: "10", deep: { m: "2" } });
    assertJsonSafe(out);
  });

  it("converts Map and Set to plain JSON structures", () => {
    const out = sanitizeToolResult({
      m: new Map<string, unknown>([["a", 1], ["b", 2n]]),
      s: new Set([1, 2, 2]),
    }) as any;
    expect(out.m).toEqual({ a: 1, b: "2" });
    expect(out.s).toEqual([1, 2, 2]);
    assertJsonSafe(out);
  });

  it("converts Date to an ISO string", () => {
    const d = new Date("2026-07-26T00:00:00.000Z");
    const out = sanitizeToolResult({ at: d }) as any;
    expect(out.at).toBe("2026-07-26T00:00:00.000Z");
    assertJsonSafe(out);
  });

  it("drops functions and symbols", () => {
    const out = sanitizeToolResult({
      keep: 1,
      fn: () => 42,
      sym: Symbol("x"),
    }) as any;
    expect(out).toEqual({ keep: 1 });
    assertJsonSafe(out);
  });

  it("breaks circular references instead of throwing", () => {
    const a: any = { name: "a" };
    a.self = a;
    const out = sanitizeToolResult(a) as any;
    expect(out.name).toBe("a");
    expect(out.self).toBe("[Circular]");
    assertJsonSafe(out);
  });

  it("does NOT flag shared (non-cyclic) sibling references as circular", () => {
    const shared = { v: 1 };
    const out = sanitizeToolResult({ x: shared, y: shared }) as any;
    expect(out).toEqual({ x: { v: 1 }, y: { v: 1 } });
    assertJsonSafe(out);
  });

  it("maps undefined array holes to null (mirrors JSON.stringify)", () => {
    const out = sanitizeToolResult({ arr: [1, undefined, 3] }) as any;
    expect(out.arr).toEqual([1, null, 3]);
    assertJsonSafe(out);
  });

  it("preserves a valid top-level string / array (no gratuitous wrapping)", () => {
    expect(sanitizeToolResult("done")).toBe("done");
    expect(sanitizeToolResult([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
});

describe("hardenToolResults", () => {
  // Minimal tool factory — mirrors the { description, inputSchema, execute }
  // shape the agent registers; only `execute` matters here.
  const makeTool = (execute: (...a: any[]) => any): Tool =>
    ({ description: "t", execute } as unknown as Tool);

  it("wraps an execute that returns undefined so the SDK sees { ok: false }", async () => {
    const tools = { skill_tool: makeTool(async () => undefined) };
    hardenToolResults(tools);
    const out = await (tools.skill_tool as any).execute({});
    expect(out).toEqual({ ok: false });
    assertJsonSafe(out);
  });

  it("sanitizes a non-serializable return from a wrapped tool", async () => {
    const tools = { t: makeTool(async () => ({ big: 5n, when: new Date(0) })) };
    hardenToolResults(tools);
    const out = await (tools.t as any).execute({});
    expect(out).toEqual({ big: "5", when: "1970-01-01T00:00:00.000Z" });
    assertJsonSafe(out);
  });

  it("forwards all call arguments (input + SDK options) verbatim", async () => {
    let seen: any[] = [];
    const tools = {
      t: makeTool(async (...args: any[]) => {
        seen = args;
        return { ok: true };
      }),
    };
    hardenToolResults(tools);
    const opts = { toolCallId: "call_1", messages: [], abortSignal: undefined };
    await (tools.t as any).execute({ a: 1 }, opts);
    expect(seen[0]).toEqual({ a: 1 });
    expect(seen[1]).toBe(opts);
  });

  it("is idempotent — double-hardening does not double-wrap", async () => {
    let calls = 0;
    const tools = {
      t: makeTool(async () => {
        calls++;
        return undefined;
      }),
    };
    hardenToolResults(tools);
    const first = tools.t.execute;
    hardenToolResults(tools);
    expect(tools.t.execute).toBe(first); // same wrapper, not re-wrapped
    await (tools.t as any).execute({});
    expect(calls).toBe(1); // underlying execute invoked exactly once
  });

  it("leaves tools without a function execute untouched", () => {
    const clientTool = { description: "client-side" } as unknown as Tool;
    const tools = { c: clientTool };
    hardenToolResults(tools);
    expect((tools.c as any).execute).toBeUndefined();
  });

  it("passes a streaming (async-iterable) tool result through un-scrubbed", async () => {
    async function* gen() {
      yield "a";
      yield "b";
    }
    const stream = gen();
    const tools = { s: makeTool(async () => stream) };
    hardenToolResults(tools);
    const out = await (tools.s as any).execute({});
    expect(out).toBe(stream); // same iterator, not coerced to { ok: false }
  });

  it("propagates errors thrown by the underlying execute", async () => {
    const tools = {
      t: makeTool(async () => {
        throw new Error("boom");
      }),
    };
    hardenToolResults(tools);
    await expect((tools.t as any).execute({})).rejects.toThrow("boom");
  });
});
