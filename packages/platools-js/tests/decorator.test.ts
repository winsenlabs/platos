/**
 * Tool registration tests — covers `platools.tool()` factory.
 *
 * Mirrors `platools-py/tests/test_decorator.py`. Anchored on PRD
 * §5.1: every tool fully typed, schemas auto-generated, registry
 * rejects duplicates, handler returned unchanged.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Platools } from "../src/platools.js";

describe("platools.tool() factory", () => {
  it("registers a tool and returns the handler unchanged", async () => {
    const platools = new Platools();
    const handler = async (params: { name: string }): Promise<{ greeting: string }> => ({
      greeting: `hello ${params.name}`,
    });

    const registered = platools.tool(
      {
        name: "greet",
        description: "Greet a user by name",
        input: z.object({ name: z.string() }),
        output: z.object({ greeting: z.string() }),
      },
      handler,
    );

    // Handler is returned identity — callable without the registry.
    expect(registered).toBe(handler);
    // CTX.5: `ctx` is optional; handlers that omit it are callable
    // with just `(params)`. Keep the two-arg form here to exercise
    // the full signature path.
    const result = await registered({ name: "ada" }, { callId: "test", context: {}, raw: {} });
    expect(result).toEqual({ greeting: "hello ada" });

    // Registry sees exactly one tool with matching metadata.
    const tool = platools.getTool("greet");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("greet");
    expect(tool!.description).toBe("Greet a user by name");
    expect(tool!.auth).toBe("none");
    expect(tool!.roles).toEqual([]);
    expect(Object.keys(platools.tools)).toEqual(["greet"]);
  });

  it("rejects duplicate tool names", () => {
    const platools = new Platools();
    const spec = {
      name: "dup",
      description: "first",
      input: z.object({ v: z.string() }),
    };
    platools.tool(spec, async () => undefined);
    expect(() =>
      platools.tool(spec, async () => undefined),
    ).toThrow(/already registered/);
  });

  it("rejects invalid auth levels", () => {
    const platools = new Platools();
    // Cast through unknown so the runtime guardrail can be exercised
    // without disabling the strict type system — a consumer who
    // bypasses the AuthLevel union should still get a runtime error.
    const badOptions = {
      name: "bad",
      description: "-",
      input: z.object({}),
      auth: "root" as unknown as "none",
    };
    expect(() => platools.tool(badOptions, async () => undefined)).toThrow(
      /auth must be one of/,
    );
  });

  it("rejects non-positive timeouts", () => {
    const platools = new Platools();
    expect(() =>
      platools.tool(
        { name: "slow", description: "-", input: z.object({}), timeoutMs: 0 },
        async () => undefined,
      ),
    ).toThrow(/timeoutMs must be positive/);
  });

  it("rejects tools with no name", () => {
    const platools = new Platools();
    expect(() =>
      platools.tool(
        { name: "", description: "-", input: z.object({}) },
        async () => undefined,
      ),
    ).toThrow(/`name` is required/);
  });

  it("rejects tools with no input schema", () => {
    const platools = new Platools();
    // Cast through unknown to exercise the runtime check without
    // disabling strict typing — a consumer who bypasses the required
    // `input` property should still get a runtime error.
    const missingInput = {
      name: "x",
      description: "-",
      input: undefined as unknown as z.ZodTypeAny,
    };
    expect(() => platools.tool(missingInput, async () => undefined)).toThrow(
      /`input` .* is required/,
    );
  });

  it("isolates registries across Platools instances", () => {
    const a = new Platools();
    const b = new Platools();
    a.tool(
      { name: "only_in_a", description: "-", input: z.object({}) },
      async () => undefined,
    );
    expect(a.getTool("only_in_a")).toBeDefined();
    expect(b.getTool("only_in_a")).toBeUndefined();
  });

  it("exposes MCP schemas via getMcpSchemas()", () => {
    const platools = new Platools();
    platools.tool(
      {
        name: "sum",
        description: "Add two integers",
        input: z.object({ a: z.number().int(), b: z.number().int() }),
        output: z.object({ total: z.number().int() }),
      },
      ({ a, b }) => ({ total: a + b }),
    );
    const schemas = platools.getMcpSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe("sum");
    expect(schemas[0]!.inputSchema.type).toBe("object");
    expect(schemas[0]!.outputSchema).not.toBeNull();
  });
});
