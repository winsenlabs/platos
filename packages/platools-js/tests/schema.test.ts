/**
 * Zod → JSON Schema generation tests.
 *
 * Mirrors `platools-py/tests/test_schema_gen.py`. PRD §5.1 requires
 * byte-compatible JSON schemas between SDKs so the platform's tool
 * registry table can diff without caring which SDK produced it.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SchemaError,
  buildInputSchema,
  buildOutputSchema,
  buildSchemas,
} from "../src/core/schema.js";

describe("buildInputSchema", () => {
  it("emits an object schema with properties and required fields", () => {
    const schema = buildInputSchema(
      "refund",
      z.object({
        orderId: z.string().describe("The order id"),
        reason: z.string().describe("Reason for refund"),
      }),
    );
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties!).sort()).toEqual(["orderId", "reason"]);
    expect(schema.required).toEqual(["orderId", "reason"]);
    expect(schema.properties!["orderId"]!.description).toBe("The order id");
  });

  it("marks optional fields as non-required", () => {
    const schema = buildInputSchema(
      "list_orders",
      z.object({
        email: z.string(),
        status: z.enum(["pending", "shipped"]).optional(),
      }),
    );
    expect(schema.required).toEqual(["email"]);
    expect(schema.properties!["status"]).toBeDefined();
  });

  it("drops zod-to-json-schema noise fields ($schema, title, additionalProperties:false)", () => {
    const schema = buildInputSchema("x", z.object({ v: z.string() }));
    expect(schema["$schema"]).toBeUndefined();
    expect(schema.title).toBeUndefined();
    expect(schema.additionalProperties).toBeUndefined();
  });

  it("throws SchemaError when the input is not an object schema", () => {
    // `buildInputSchema` accepts any `ZodTypeAny`; the runtime check
    // rejects non-object schemas after introspecting the generated
    // JSON Schema. A `z.string()` *is* a `ZodTypeAny`, so this
    // invocation is type-legal — the error comes from the runtime
    // guardrail in `buildInputSchema` itself.
    expect(() => buildInputSchema("bad", z.string())).toThrow(SchemaError);
  });
});

describe("buildOutputSchema", () => {
  it("returns null when no output schema is provided", () => {
    expect(buildOutputSchema("no_output", undefined)).toBeNull();
  });

  it("converts an object output schema", () => {
    const schema = buildOutputSchema(
      "refund",
      z.object({
        refundId: z.string(),
        amountCents: z.number().int(),
      }),
    );
    expect(schema).not.toBeNull();
    expect(schema!.type).toBe("object");
    expect(schema!.required).toEqual(["refundId", "amountCents"]);
  });
});

describe("buildSchemas", () => {
  it("emits both input and output schemas in one pass", () => {
    const result = buildSchemas({
      name: "probe",
      description: "test",
      input: z.object({ a: z.string() }),
      output: z.object({ b: z.number() }),
    });
    expect(result.inputSchema.type).toBe("object");
    expect(result.outputSchema).not.toBeNull();
    expect(result.outputSchema!.type).toBe("object");
  });
});
