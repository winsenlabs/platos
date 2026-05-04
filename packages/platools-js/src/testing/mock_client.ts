/**
 * In-process MCP-style mock client.
 *
 * Ported from `platools/testing/mock_client.py`. `platools test`
 * doesn't open a real WebSocket — this wrapper mimics the MCP
 * tools surface so the CLI can exercise the same dispatch code
 * path the real transport uses.
 */

import type { ToolRegistry } from "../core/registry.js";
import type { JsonSchema } from "../types.js";
import { ToolTestRunner, type TestResult } from "./runner.js";

export interface MockToolListing {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema | null;
  readonly annotations: Readonly<Record<string, unknown>>;
}

export class MockMcpClient {
  private readonly runner: ToolTestRunner;

  public constructor(private readonly registry: ToolRegistry) {
    this.runner = new ToolTestRunner(registry);
  }

  public listTools(): MockToolListing[] {
    return this.registry.all().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }));
  }

  public async callTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<TestResult> {
    return this.runner.runAsync(name, params);
  }
}
