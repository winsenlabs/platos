import { Injectable } from "@nestjs/common";
import { ToolRegistryService, type OrgToolEntry } from "./tool-registry.service";
import { z } from "zod";
// AI SDK v6 — `CoreTool` renamed to `Tool`.
import type { Tool as CoreTool } from "ai";
import type { RequestScope } from "../auth/scope.guard";

type ScopeLike = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

/**
 * SchemaInjectorService — Mode 2: Direct schema injection.
 *
 * When the agent calls find_tools, this service:
 * 1. Gets the matched tools from BM25 (scope-filtered)
 * 2. Converts their JSON Schemas to Zod schemas for Vercel AI SDK
 * 3. Returns CoreTool definitions that can be added to streamText/generateText
 *
 * These tools are injected for the tool-calling turn only, then removed
 * on non-tool turns to keep context lean.
 */
@Injectable()
export class SchemaInjectorService {
  constructor(private readonly toolRegistry: ToolRegistryService) {}

  /**
   * Convert tool entries to Vercel AI SDK CoreTool definitions.
   * The execute function routes to the entity backend via ToolExecutorService.
   */
  buildToolDefinitions(
    tools: OrgToolEntry[],
    executeHandler: (toolName: string, params: Record<string, unknown>) => Promise<unknown>,
  ): Record<string, CoreTool> {
    const result: Record<string, CoreTool> = {};

    for (const tool of tools) {
      const zodSchema = this.jsonSchemaToZod(tool.paramSchema);
      result[tool.toolName] = {
        description: tool.description,
        // AI SDK v6 — `parameters` → `inputSchema`.
        inputSchema: zodSchema,
        execute: async (params: Record<string, unknown>) => {
          return executeHandler(tool.toolName, params);
        },
      } as CoreTool;
    }

    return result;
  }

  /**
   * Get injectable tool definitions for a scope based on a query.
   * Combines BM25 search + schema conversion in one call.
   */
  getInjectableTools(
    query: string,
    scope: ScopeLike,
    executeHandler: (toolName: string, params: Record<string, unknown>) => Promise<unknown>,
    options: { limit?: number; sourceEntityId?: string } = {},
  ): Record<string, CoreTool> {
    const matches = this.toolRegistry.findTools(query, scope, options.limit ?? 15, options.sourceEntityId);
    return this.buildToolDefinitions(matches, executeHandler);
  }

  /**
   * Get ALL tools for a scope as injectable definitions.
   * Used for Mode 1 (GPT-OSS) where all schemas are loaded.
   */
  getAllInjectableTools(
    scope: ScopeLike,
    executeHandler: (toolName: string, params: Record<string, unknown>) => Promise<unknown>,
    options: { sourceEntityId?: string } = {},
  ): Record<string, CoreTool> {
    const allTools = this.toolRegistry.getScopedTools(scope, { sourceEntityId: options.sourceEntityId });
    return this.buildToolDefinitions(allTools, executeHandler);
  }

  /**
   * Convert a JSON Schema object to a Zod schema.
   * Handles the common cases: string, number, boolean, array, object.
   * Falls back to z.record(z.unknown()) for complex schemas.
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
    if (!schema || typeof schema !== "object") {
      return z.object({});
    }

    const properties = schema.properties as Record<string, any> | undefined;
    const required = (schema.required as string[]) || [];

    if (!properties) {
      return z.record(z.unknown());
    }

    const shape: Record<string, z.ZodType> = {};
    for (const [key, prop] of Object.entries(properties)) {
      let fieldSchema = this.convertProperty(prop);

      if (prop.description) {
        fieldSchema = fieldSchema.describe(prop.description);
      }

      if (!required.includes(key)) {
        fieldSchema = fieldSchema.optional();
      }

      shape[key] = fieldSchema;
    }

    return z.object(shape);
  }

  private convertProperty(prop: any): z.ZodType {
    if (!prop || typeof prop !== "object") return z.unknown();

    switch (prop.type) {
      case "string":
        if (prop.enum) return z.enum(prop.enum);
        return z.string();
      case "number":
      case "integer":
        return z.number();
      case "boolean":
        return z.boolean();
      case "array":
        if (prop.items) return z.array(this.convertProperty(prop.items));
        return z.array(z.unknown());
      case "object":
        if (prop.properties) return this.jsonSchemaToZod(prop);
        return z.record(z.unknown());
      default:
        return z.unknown();
    }
  }
}
