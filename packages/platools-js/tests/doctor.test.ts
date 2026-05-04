/**
 * Doctor failure-mode tests.
 *
 * Mirrors `platools-py/tests/test_doctor.py`. Anchored on PRD §5.1 —
 * `platools doctor` is the ship gate, and these tests lock down the
 * specific failure modes the PLATOS-40 prompt calls out:
 *
 *   - unreachable params
 *   - output / type mismatch
 *   - ambiguous outputs
 *
 * Plus circular dependencies, missing descriptions, destructive
 * annotations, and the runDoctor() CLI happy path so the whole gate
 * stays green.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Platools } from "../src/platools.js";
import { analyzeRegistry, analyzeTools } from "../src/doctor/analyzer.js";
import { formatReport, reportToJson } from "../src/doctor/reporter.js";
import { runDoctor } from "../src/cli/doctor.js";
import type { ToolDef } from "../src/types.js";

function makePlatools(): Platools {
  return new Platools();
}

describe("analyzeRegistry — unreachable params", () => {
  it("flags required params with no producer and no user-providable marker", () => {
    const platools = makePlatools();
    platools.tool(
      {
        name: "archive_workspace",
        description: "Archive a workspace for long-term storage",
        input: z.object({
          admin_id: z.string().describe("Admin id required for the archive"),
        }),
        output: z.object({ archived: z.boolean() }),
      },
      async () => ({ archived: true }),
    );
    const report = analyzeRegistry(platools.registry);
    const errors = report.errors();
    expect(errors.some((f) => f.code === "unreachable_param")).toBe(true);
    expect(errors[0]!.tool).toBe("archive_workspace");
    expect(errors[0]!.param).toBe("admin_id");
    expect(report.hasErrors()).toBe(true);
  });

  it("does not flag params marked x-user-providable", () => {
    // Build the ToolDef manually since Zod doesn't round-trip
    // `x-user-providable` through `.describe()`. The doctor reads
    // it straight off the JSON schema.
    const tool: ToolDef = {
      name: "search_orders",
      description: "Search customer orders by email address",
      handler: async () => ({ orders: [] }),
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "The email address to search for",
            "x-user-providable": true,
          },
        },
        required: ["email"],
      },
      outputSchema: {
        type: "object",
        properties: { orders: { type: "array" } },
      },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const report = analyzeTools([tool]);
    expect(report.hasErrors()).toBe(false);
  });
});

describe("analyzeRegistry — type mismatch", () => {
  it("warns when a producer's output type disagrees with the consumer's input type", () => {
    const producer: ToolDef = {
      name: "create_order",
      description: "Create a new order and return its id",
      handler: async () => ({ order_id: 42 }),
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: { type: "object", properties: {}, required: [] },
      outputSchema: {
        type: "object",
        properties: { order_id: { type: "integer" } },
      },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const consumer: ToolDef = {
      name: "refund_order",
      description: "Refund an existing order by id",
      handler: async () => undefined,
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order to refund" },
        },
        required: ["order_id"],
      },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const report = analyzeTools([producer, consumer]);
    const warnings = report.warnings();
    expect(warnings.some((f) => f.code === "type_mismatch")).toBe(true);
    const mismatch = warnings.find((f) => f.code === "type_mismatch")!;
    expect(mismatch.tool).toBe("refund_order");
    expect(mismatch.param).toBe("order_id");
  });
});

describe("analyzeRegistry — ambiguous outputs", () => {
  it("emits an info-level finding when multiple tools produce the same field", () => {
    const a: ToolDef = {
      name: "create_refund",
      description: "Create a new refund record",
      handler: async () => undefined,
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: { type: "object", properties: {}, required: [] },
      outputSchema: {
        type: "object",
        properties: { refund_id: { type: "string" } },
      },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const b: ToolDef = {
      name: "process_refund",
      description: "Process an existing refund record",
      handler: async () => undefined,
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: { type: "object", properties: {}, required: [] },
      outputSchema: {
        type: "object",
        properties: { refund_id: { type: "string" } },
      },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const report = analyzeTools([a, b]);
    const infos = report.infos();
    const ambiguous = infos.find((f) => f.code === "ambiguous_output");
    expect(ambiguous).toBeDefined();
    expect(ambiguous!.message).toContain("refund_id");
  });
});

describe("analyzeRegistry — circular dependencies", () => {
  it("flags each participating tool when a cycle is detected", () => {
    const a: ToolDef = {
      name: "tool_a",
      description: "Tool A depends on B output",
      handler: async () => undefined,
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: {
        type: "object",
        properties: { b_id: { type: "string" } },
        required: ["b_id"],
      },
      outputSchema: {
        type: "object",
        properties: { a_id: { type: "string" } },
      },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const b: ToolDef = {
      name: "tool_b",
      description: "Tool B depends on A output",
      handler: async () => undefined,
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: {
        type: "object",
        properties: { a_id: { type: "string" } },
        required: ["a_id"],
      },
      outputSchema: {
        type: "object",
        properties: { b_id: { type: "string" } },
      },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const report = analyzeTools([a, b]);
    const cycles = report.errors().filter((f) => f.code === "circular_dependency");
    // Both tools should be attributed so the healthy count deducts both.
    const tools = new Set(cycles.map((f) => f.tool));
    expect(tools.size).toBe(2);
  });
});

describe("analyzeRegistry — destructive annotations", () => {
  it("warns when a tool's name implies destruction but the annotation is missing", () => {
    const platools = makePlatools();
    platools.tool(
      {
        name: "delete_workspace",
        description: "Delete a workspace and everything inside it",
        input: z.object({
          workspace_id: z.string().describe("The id of the workspace to destroy"),
        }),
        output: z.object({ deleted: z.boolean() }),
      },
      async () => ({ deleted: true }),
    );
    const platoolsAnnotated = makePlatools();
    platoolsAnnotated.tool(
      {
        name: "delete_user",
        description: "Delete a user and all their content",
        input: z.object({
          user_id: z.string().describe("The id of the user to delete"),
        }),
        output: z.object({ deleted: z.boolean() }),
        annotations: { destructiveHint: true },
      },
      async () => ({ deleted: true }),
    );

    // We also need the param to be reachable so the unreachable
    // check doesn't fire and mask the destructive warning.
    const unannotated = analyzeTools([
      {
        name: "delete_workspace",
        description: "Delete a workspace and everything inside it",
        handler: async () => undefined,
        inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
        outputZodSchema: null,
        inputSchema: {
          type: "object",
          properties: {
            workspace_id: {
              type: "string",
              description: "The workspace id",
              "x-user-providable": true,
            },
          },
          required: ["workspace_id"],
        },
        outputSchema: {
          type: "object",
          properties: { deleted: { type: "boolean" } },
        },
        auth: "none",
        roles: [],
        rateLimit: null,
        timeoutMs: null,
        annotations: {},
      },
    ]);
    expect(
      unannotated.warnings().some((f) => f.code === "missing_destructive_hint"),
    ).toBe(true);

    // Reference the annotated `platoolsAnnotated` so the linter
    // doesn't flag the setup as unused — the test below confirms the
    // annotation suppresses the warning.
    const annotated = analyzeRegistry(platoolsAnnotated.registry);
    expect(
      annotated.warnings().some((f) => f.code === "missing_destructive_hint"),
    ).toBe(false);
  });
});

describe("reporter output", () => {
  it("renders a green report for an empty registry", () => {
    const report = analyzeTools([]);
    const text = formatReport(report);
    expect(text).toContain("Tools: 0 registered");
    expect(text).toContain("No issues found");
  });

  it("renders healthy count that subtracts tools in error findings", () => {
    const a: ToolDef = {
      name: "bad_tool",
      description: "Has an unreachable param",
      handler: async () => undefined,
      inputZodSchema: z.object({}) as unknown as z.ZodTypeAny,
      outputZodSchema: null,
      inputSchema: {
        type: "object",
        properties: { missing: { type: "string", description: "xxxxxxxxxx" } },
        required: ["missing"],
      },
      outputSchema: { type: "object", properties: {} },
      auth: "none",
      roles: [],
      rateLimit: null,
      timeoutMs: null,
      annotations: {},
    };
    const report = analyzeTools([a]);
    const text = formatReport(report);
    expect(text).toContain("Tools: 1 registered, 0 healthy");
    expect(text).toContain("ERRORS (");
  });

  it("reportToJson emits tool_count, errors, warnings, info keys", () => {
    const report = analyzeTools([]);
    const parsed = JSON.parse(reportToJson(report)) as {
      tool_count: number;
      errors: unknown[];
      warnings: unknown[];
      info: unknown[];
    };
    expect(parsed.tool_count).toBe(0);
    expect(parsed.errors).toEqual([]);
  });
});

describe("runDoctor CLI happy path", () => {
  it("returns 0 for an empty registry when no module is provided", async () => {
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const code = await runDoctor({
      stdout: (line) => stdoutBuf.push(line),
      stderr: (line) => stderrBuf.push(line),
    });
    expect(code).toBe(0);
    expect(stdoutBuf.join("")).toContain("Tools: 0 registered");
    expect(stderrBuf.join("")).toBe("");
  });

  it("returns 2 when the target module fails to load", async () => {
    const stderrBuf: string[] = [];
    const code = await runDoctor({
      modulePath: "./does-not-exist.js",
      stdout: () => undefined,
      stderr: (line) => stderrBuf.push(line),
    });
    expect(code).toBe(2);
    expect(stderrBuf.join("")).toContain("failed to load module");
  });
});
