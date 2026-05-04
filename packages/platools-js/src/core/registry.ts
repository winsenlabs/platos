/**
 * Tool registry — tracks every `platools.tool()` registered tool.
 *
 * Mirrors `platools/core/registry.py`. The registry is a plain map
 * behind a thin API so the decorator, transport, and doctor can all
 * share a single view of the consumer's registered tools.
 */

import type { ToolDef } from "../types.js";

export class ToolRegistry {
  private readonly tools: Map<string, ToolDef> = new Map();

  public register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `tool "${tool.name}" is already registered — tool names must be unique`,
      );
    }
    this.tools.set(tool.name, tool);
  }

  public get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  public all(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  public names(): string[] {
    return Array.from(this.tools.keys());
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get size(): number {
    return this.tools.size;
  }
}
