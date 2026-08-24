/**
 * Theme F.5 — unit tests for the structured-output enforcement helpers.
 *
 * These tests exercise the pure logic inside `structured-output.ts`
 * (normalizeSchema / resolveTurnSchema / validateAgainstSchema /
 * buildRetryCorrectionMessage / StructuredOutputError). No network, no DB,
 * no mocks — just shape-checking pure functions so they're safe to run
 * everywhere (per CLAUDE.md §9.11 — Vitest only, never mock).
 *
 * The end-to-end wiring into `AgentService.stream` / `AgentService.run`
 * requires a live model, so it's verified on the VPS via the test harness
 * at `test.platos.dev` after deploy (not in this file).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  normalizeSchema,
  resolveTurnSchema,
  validateAgainstSchema,
  buildRetryCorrectionMessage,
  StructuredOutputError,
} from "./structured-output";

describe("structured-output: normalizeSchema", () => {
  it("returns null for null/undefined/empty object", () => {
    expect(normalizeSchema(null)).toBeNull();
    expect(normalizeSchema(undefined)).toBeNull();
    expect(normalizeSchema({})).toBeNull();
  });

  it("returns the Zod instance unchanged", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = normalizeSchema(schema);
    // Same instance — Zod short-circuit.
    expect(result).toBe(schema);
  });

  it("wraps a JSON Schema object via ai.jsonSchema()", () => {
    const jsonSchema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };
    const result = normalizeSchema(jsonSchema);
    expect(result).not.toBeNull();
    // ai-sdk Schema exposes a `.validate` function — that's our duck-type.
    expect(typeof (result as any)?.validate === "function").toBe(true);
  });

  it("isolates repeated caller-controlled JSON Schema IDs", () => {
    const schema = {
      $id: "https://example.test/shared-output-schema",
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };

    const first = normalizeSchema(structuredClone(schema));
    const second = normalizeSchema(structuredClone(schema));

    expect((first as any).validate({ count: 1 })).toMatchObject({ success: true });
    expect((second as any).validate({ count: 2 })).toMatchObject({ success: true });
  });

  it("throws on non-object, non-Zod input", () => {
    expect(() => normalizeSchema("not a schema" as any)).toThrow(
      /Unsupported outputSchema type/,
    );
    expect(() => normalizeSchema(42 as any)).toThrow(
      /Unsupported outputSchema type/,
    );
  });
});

describe("structured-output: resolveTurnSchema", () => {
  it("returns null when neither per-turn nor agent default is set", () => {
    expect(resolveTurnSchema({})).toBeNull();
    expect(resolveTurnSchema({ perTurn: null, agentDefault: null })).toBeNull();
    expect(resolveTurnSchema({ perTurn: {}, agentDefault: {} })).toBeNull();
  });

  it("per-turn wins when both present", () => {
    const perTurn = z.object({ turn: z.boolean() });
    const agentDefault = z.object({ agent: z.boolean() });
    expect(resolveTurnSchema({ perTurn, agentDefault })).toBe(perTurn);
  });

  it("falls back to agent default when per-turn is null/empty", () => {
    const agentDefault = z.object({ agent: z.boolean() });
    expect(resolveTurnSchema({ perTurn: null, agentDefault })).toBe(
      agentDefault,
    );
    expect(resolveTurnSchema({ perTurn: {}, agentDefault })).toBe(agentDefault);
    expect(resolveTurnSchema({ agentDefault })).toBe(agentDefault);
  });
});

describe("structured-output: validateAgainstSchema", () => {
  it("accepts valid Zod object", () => {
    const schema = z.object({ count: z.number().int() });
    const result = validateAgainstSchema(schema, { count: 42 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toEqual({ count: 42 });
  });

  it("returns path-prefixed Zod errors", () => {
    const schema = z.object({ count: z.number().int() });
    const result = validateAgainstSchema(schema, { count: "oops" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error paths get joined; missing fields surface sensibly.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("count:");
    }
  });

  it("accepts valid JSON Schema object", () => {
    const normalized = normalizeSchema({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    if (!normalized) throw new Error("normalize returned null");
    const result = validateAgainstSchema(normalized, { name: "hello" });
    expect(result.success).toBe(true);
  });

  it("returns errors for JSON-Schema violations", () => {
    const normalized = normalizeSchema({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    if (!normalized) throw new Error("normalize returned null");
    const result = validateAgainstSchema(normalized, { name: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("structured-output: buildRetryCorrectionMessage", () => {
  it("includes validation errors (capped at 10)", () => {
    const errors = Array.from({ length: 15 }).map((_, i) => `err ${i}`);
    const msg = buildRetryCorrectionMessage("prior output", errors);
    expect(msg).toContain("err 0");
    expect(msg).toContain("err 9");
    // Cap: 10 errors only, err 10+ excluded.
    expect(msg).not.toContain("err 10");
    expect(msg).toContain("prior output");
  });

  it("gracefully handles undefined rawText", () => {
    const msg = buildRetryCorrectionMessage(undefined, ["missing root"]);
    expect(msg).toContain("could not be parsed as JSON");
    expect(msg).toContain("missing root");
  });

  it("truncates extremely long prior output", () => {
    const long = "x".repeat(8000);
    const msg = buildRetryCorrectionMessage(long, ["bad"]);
    // The 4000-char cap is reached — total message is bounded.
    expect(msg.length).toBeLessThan(long.length);
  });
});

describe("structured-output: StructuredOutputError", () => {
  it("carries code, retryCount, and errors", () => {
    const err = new StructuredOutputError("failed", {
      retryCount: 1,
      validationErrors: ["root: expected string"],
      rawText: '{"x":1}',
    });
    expect(err.name).toBe("StructuredOutputError");
    expect(err.code).toBe("structured_output_invalid");
    expect(err.retryCount).toBe(1);
    expect(err.validationErrors).toEqual(["root: expected string"]);
    expect(err.rawText).toBe('{"x":1}');
    expect(err).toBeInstanceOf(Error);
  });
});
